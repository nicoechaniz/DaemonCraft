import threading, queue, time, requests, json, yaml, os

class RunnerThread(threading.Thread):
    def __init__(self, bot_api_url, config_path=None):
        super().__init__(daemon=True)
        self.bot_api = bot_api_url
        self.event_queue = queue.Queue()
        self.personality = self._load_config(config_path)
        self._running = True
        self._last_follow = {}     # entity_type -> timestamp of last follow start
        self._follow_timeout = 5   # seconds before giving up on a follow
        self._flee_failed = {}     # entity_type -> count of failed flees
        self._flee_positions = {}  # entity_type -> position at last flee attempt

    def _load_config(self, path):
        default = {
            'combat': {'threshold': 0.4, 'flee_health': 6, 'preferred_weapon': 'iron_sword'},
            'survival': {'eat_when_hunger_below': 6, 'avoid_lava': True},
            'social': {'loyalty': 0.9, 'follow_distance': 5}
        }
        if path and os.path.exists(path):
            with open(path) as f:
                cfg = yaml.safe_load(f)
                return cfg.get('runner', default)
        default_path = os.path.expanduser('~/.config/daemoncraft/runner.yaml')
        if os.path.exists(default_path):
            with open(default_path) as f:
                cfg = yaml.safe_load(f)
                return cfg.get('runner', default)
        return default

    def run(self):
        while self._running:
            try:
                event = self.event_queue.get(timeout=0.5)
                if event.get('priority') == 'critical':
                    self._handle_critical(event)
                elif event.get('priority') == 'high':
                    self._handle_high(event)
            except queue.Empty:
                continue

    def stop(self):
        self._running = False

    def push_event(self, event):
        self.event_queue.put(event)

    def _post(self, path, data, timeout=30):
        return requests.post(f'{self.bot_api}{path}', json=data, timeout=timeout).json()

    def _get(self, path):
        return requests.get(f'{self.bot_api}{path}', timeout=5).json()

    def _has_weapon(self):
        """Check if the bot is holding or has a weapon in inventory."""
        try:
            st = self._get('/status')
            holding = st.get('data', {}).get('holding', {})
            name = holding.get('name', '')
            if any(w in name for w in ['sword', 'axe', 'trident', 'mace']):
                return True
        except:
            pass
        return False

    def _has_armor(self):
        """Check if the bot has any armor equipped (via /status equipment)."""
        try:
            st = self._get('/status')
            eq = st.get('data', {}).get('equipment', [])
            if eq and len(eq) > 0:
                return True
        except:
            pass
        return False

    def _handle_critical(self, event):
        result = self._post('/mutex/claim', {
            'requester': 'runner', 'critical': True,
            'actionTag': 'preemptible'
        })
        if not result.get('allowed'):
            reason = result.get('reason', '')
            if reason == 'atomic_in_progress' and event['type'] in ('voice_command', 'health_low', 'lava_near'):
                self._post('/mutex/emergency_stop', {'requester': 'runner'})
            else:
                return

        action = self._select_action(event)
        if not action:
            self._post('/mutex/release', {'requester': 'runner'})
            return

        self._execute_action(action)

        # After flee, check if we actually escaped
        if action.get('name') == 'flee':
            entity_type = action.get('params', {}).get('from', '')
            self._check_flee_result(entity_type)

        self._post('/mutex/release', {'requester': 'runner'})

    def _handle_high(self, event):
        result = self._post('/mutex/claim', {
            'requester': 'runner', 'critical': False
        })
        if not result.get('allowed'):
            return
        action = self._select_action(event)
        if action:
            self._execute_action(action)
        self._post('/mutex/release', {'requester': 'runner'})

    def _select_action(self, event):
        etype = event['type']
        p = self.personality

        if etype == 'entity_near':
            entity_type = event.get('entityType', 'hostile')
            dist = event.get('distance', 999)

            # --- Follow timeout: abandon if we've been following >5s ---
            follow_start = self._last_follow.get(entity_type, 0)
            if follow_start and time.time() - follow_start > self._follow_timeout:
                return None

            # --- Distance gate: don't chase if mob is too far ---
            if dist > 15:
                return None

            # --- Situational awareness ---
            has_weapon = self._has_weapon()
            has_armor = self._has_armor()

            # Flee conditions: no weapon, no armor, cowardly personality, or previous flee failures
            must_flee = (
                not has_weapon or
                not has_armor or
                p['combat']['threshold'] < 0.5
            )

            # Check if previous flee against this entity failed (didn't move)
            flee_count = self._flee_failed.get(entity_type, 0)
            if flee_count >= 2:
                # Flee keeps failing — fight instead
                must_flee = False

            if must_flee:
                self._flee_positions[entity_type] = None  # will be set after flee attempt
                return {'name': 'flee', 'params': {'from': entity_type, 'distance': 8}}

            # Fight: follow + attack loop (follow lasts until timeout or mob gone)
            self._last_follow[entity_type] = time.time()
            self._flee_failed[entity_type] = 0  # reset flee counter
            return {'name': 'follow', 'params': {'player': entity_type}, 'also_attack': entity_type}

        elif etype in ('health_low', 'hunger_low'):
            return {'name': 'eat', 'params': {}}
        elif etype == 'voice_command' and event.get('intent') == 'emergency_stop':
            return {'name': 'stop', 'params': {}}
        return None

    def _execute_action(self, action):
        name = action['name']
        params = action.get('params', {})

        if name == 'stop':
            self._post('/action/stop', {'requester': 'runner'})

        elif name == 'flee':
            # Record position before flee to detect if flee actually moved us
            entity_type = params.get('from', 'unknown')
            try:
                st = self._get('/status')
                pos_before = st.get('data', {}).get('position', {})
                self._flee_positions[entity_type] = (pos_before.get('x'), pos_before.get('y'), pos_before.get('z'))
            except:
                pass
            self._post('/action/flee', params)

        elif name == 'follow' and action.get('also_attack'):
            self._post('/action/follow', params)
            time.sleep(0.4)
            self._post('/action/attack', {'target': action['also_attack']}, timeout=15)

        else:
            self._post(f'/action/{name}', params)

    def _check_flee_result(self, entity_type):
        """After a flee action, check if we actually moved. If not, increment fail counter."""
        try:
            prev = self._flee_positions.get(entity_type)
            if not prev:
                return
            st = self._get('/status')
            pos = st.get('data', {}).get('position', {})
            dx = (pos.get('x', 0) or 0) - (prev[0] or 0)
            dy = (pos.get('y', 0) or 0) - (prev[1] or 0)
            dz = (pos.get('z', 0) or 0) - (prev[2] or 0)
            moved = (dx*dx + dy*dy + dz*dz) ** 0.5
            if moved < 1.0:
                self._flee_failed[entity_type] = self._flee_failed.get(entity_type, 0) + 1
            else:
                self._flee_failed[entity_type] = 0
        except:
            pass
