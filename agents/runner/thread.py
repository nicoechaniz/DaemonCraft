import threading, queue, time, requests, json, yaml, os

class RunnerThread(threading.Thread):
    def __init__(self, bot_api_url, config_path=None):
        super().__init__(daemon=True)
        self.bot_api = bot_api_url
        self.event_queue = queue.Queue()
        self.personality = self._load_config(config_path)
        self._running = True

    def _load_config(self, path):
        # Default config
        default = {
            'combat': {'threshold': 0.4, 'flee_health': 6, 'preferred_weapon': 'iron_sword'},
            'survival': {'eat_when_hunger_below': 6, 'avoid_lava': True},
            'social': {'loyalty': 0.9, 'follow_distance': 5}
        }
        if path and os.path.exists(path):
            with open(path) as f:
                cfg = yaml.safe_load(f)
                return cfg.get('runner', default)
        # Try default location
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

    def _handle_critical(self, event):
        # 1. Claim mutex (force)
        result = self._post('/mutex/claim', {
            'requester': 'runner', 'critical': True,
            'actionTag': 'preemptible'
        })
        if not result.get('allowed'):
            reason = result.get('reason', '')
            if reason == 'atomic_in_progress' and event['type'] in ('voice_command', 'health_low', 'lava_near'):
                self._post('/mutex/emergency_stop', {'requester': 'runner'})
            else:
                return  # wait for atomic to finish

        # 2. Select action from library
        action = self._select_action(event)
        if not action:
            self._post('/mutex/release', {'requester': 'runner'})
            return

        # 3. Execute action
        self._execute_action(action)

        # 4. Release
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
            dist = event.get('distance', 999)
            entity_type = event.get('entityType', 'hostile')
            # Flee only if personality is cowardly (threshold < 0.5) or health critically low
            should_flee = p['combat']['threshold'] < 0.5
            if should_flee:
                return {'name': 'flee', 'params': {'from': entity_type, 'distance': 8}}
            else:
                return {'name': 'attack', 'params': {'target': entity_type}}
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
        else:
            self._post(f'/action/{name}', params)
