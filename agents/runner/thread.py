import threading, queue, time, requests, json, yaml, os

class RunnerThread(threading.Thread):
    def __init__(self, bot_api_url, config_path=None):
        super().__init__(daemon=True)
        self.bot_api = bot_api_url
        self.event_queue = queue.Queue()
        self.personality = self._load_config(config_path)
        self._running = True
        self._flee_failed = {}     # entity_type -> count of failed flees
        self._flee_positions = {}  # entity_type -> position at last flee attempt
        self._last_health = 20     # track health for damage detection
        self._weapon_cache = (0, False)  # (timestamp, has_weapon)
        self._active_reflex = None     # current reflex action name or None
        self._last_reflex_at = 0       # timestamp of last reflex execution
        self._reflex_history = []      # [{reflex, target, at}] last 5 reflexes
        self._last_flee_at = 0         # timestamp of last flee completion — avoid /status timeout during combat

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
                self._check_damage()  # idle health watch
                continue

    def stop(self):
        self._running = False

    def push_event(self, event):
        self.event_queue.put(event)

    def get_status(self) -> dict:
        """Return current runner state for agent heartbeat enrichment."""
        now = time.time()
        reflex = None
        if self._active_reflex and (now - self._last_reflex_at) < 5.0:
            reflex = self._active_reflex
        return {
            'active_reflex': reflex,
            'reflex_history': self._reflex_history[-5:],
            'flee_failed': dict(self._flee_failed),
        }

    def _post(self, path, data, timeout=5):
        """POST and return JSON response. For mutex ops that need the result."""
        return requests.post(f'{self.bot_api}{path}', json=data, timeout=timeout).json()

    def _post_fire(self, path, data):
        """Fire-and-forget POST for actions that may take a while."""
        try:
            requests.post(f'{self.bot_api}{path}', json=data, timeout=3)
        except:
            pass

    def _get(self, path):
        return requests.get(f'{self.bot_api}{path}', timeout=5).json()

    def _has_weapon(self):
        """Check if bot has a weapon in inventory (attack auto-equips best). Cached for 3s."""
        now = time.time()
        cache_age = now - self._weapon_cache[0]
        if cache_age < 3.0:
            return self._weapon_cache[1]
        try:
            st = self._get('/status')
            inv = st.get('data', {}).get('inventory', [])
            has = any(
                any(w in (i.get('name') or '') for w in ['sword', 'axe', 'trident', 'mace'])
                for i in inv
            )
        except:
            # /status timeout during combat — reuse last known state
            has = self._weapon_cache[1]
        self._weapon_cache = (now, has)
        return has

    def _check_damage(self):
        """Idle health watch: if health drops, react even without entity_near event."""
        try:
            st = self._get('/status')
            health = st.get('data', {}).get('health', 20)
            if health < self._last_health - 0.5:
                # Taking damage — push a synthetic event
                self._last_health = health
                self.push_event({
                    'type': 'taking_damage',
                    'health': health,
                    'priority': 'critical',
                })
            else:
                self._last_health = health
        except:
            pass

    def _handle_critical(self, event):
        result = self._post('/mutex/claim', {
            'requester': 'runner', 'critical': True,
            'actionTag': 'preemptible'
        })
        if not result.get('allowed'):
            reason = result.get('reason', '')
            if reason == 'atomic_in_progress' and event['type'] in ('voice_command', 'health_low', 'lava_near', 'taking_damage'):
                self._post('/mutex/emergency_stop', {'requester': 'runner'})
            else:
                return

        action = self._select_action(event)
        if not action:
            self._post('/mutex/release', {'requester': 'runner'})
            return

        self._execute_action(action)

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

        if etype in ('entity_near', 'taking_damage'):
            entity_type = event.get('entityType', 'hostile')
            dist = event.get('distance', 999)

            # Distance gate: don't chase if mob is too far
            if dist > 15 and etype == 'entity_near':
                return None

            # Situational awareness
            has_weapon = self._has_weapon()

            # Flee: no weapon, cowardly personality, or flee-fail cascade
            must_flee = (
                not has_weapon or
                p['combat']['threshold'] < 0.5
            )

            # Anti-flee-chain: if we fled recently and hostile is >6m, attack instead
            if must_flee and time.time() - self._last_flee_at < 4.0 and dist > 6:
                must_flee = False

            flee_count = self._flee_failed.get(entity_type, 0)
            if flee_count >= 1:
                must_flee = False  # fight instead — one failed flee is enough

            if must_flee and entity_type:
                self._flee_positions[entity_type] = None
                return {'name': 'flee', 'params': {'from': entity_type, 'distance': 8}}

            # Fight: attack (goto + hit), re-triggers on next entity_near event
            if entity_type:
                self._flee_failed[entity_type] = 0
                return {'name': 'attack', 'params': {'target': entity_type}}
            # taking_damage without known entity_type: just attack nearest
            return {'name': 'attack', 'params': {'target': ''}}

        elif etype in ('health_low', 'hunger_low'):
            return {'name': 'eat', 'params': {}}
        elif etype == 'voice_command' and event.get('intent') == 'emergency_stop':
            return {'name': 'stop', 'params': {}}
        return None

    def _execute_action(self, action):
        name = action['name']
        params = action.get('params', {})

        # Track active reflex for heartbeat enrichment
        self._active_reflex = name
        self._last_reflex_at = time.time()
        self._reflex_history.append({
            'reflex': name,
            'target': params.get('target') or params.get('from') or '',
            'at': time.time(),
        })
        if len(self._reflex_history) > 10:
            self._reflex_history = self._reflex_history[-10:]

        if name == 'stop':
            self._post('/action/stop', {'requester': 'runner'})

        elif name == 'flee':
            entity_type = params.get('from', 'unknown')
            try:
                st = self._get('/status')
                pos_before = st.get('data', {}).get('position', {})
                self._flee_positions[entity_type] = (pos_before.get('x'), pos_before.get('y'), pos_before.get('z'))
            except:
                pass
            self._post_fire('/action/flee', params)
            self._last_flee_at = time.time()

        elif name == 'attack':
            self._post_fire('/action/attack', params)

        elif name == 'eat':
            self._post_fire('/action/eat', params)

        else:
            self._post_fire(f'/action/{name}', params)

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
