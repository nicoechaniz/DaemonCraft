#!/usr/bin/env python3
"""
EventPoller — lightweight bridge for Phase 1 Reactive Runner.

Polls the bot server's GET /events endpoint (debounced producers in server.js)
and feeds events into RunnerThread.event_queue via push_event().

This decouples the Node event emission from the Python RunnerThread
without requiring WebSockets or long-poll in Phase 1.

Started from agent_loop.py right after RunnerThread.
"""

import threading
import time
import requests


class EventPoller(threading.Thread):
    """Daemon thread that polls bot /events and pushes to RunnerThread."""

    def __init__(self, bot_api_url, runner_thread, interval=0.2):
        super().__init__(daemon=True)
        self.bot_api = bot_api_url.rstrip('/')
        self.runner = runner_thread
        self.interval = interval
        self._running = True

    def run(self):
        while self._running:
            try:
                resp = requests.get(f'{self.bot_api}/events', timeout=2)
                if resp.ok:
                    payload = resp.json()
                    data = payload.get('data', {}) if isinstance(payload, dict) else {}
                    events = data.get('events', []) if isinstance(data, dict) else []
                    for event in events:
                        if isinstance(event, dict):
                            self.runner.push_event(event)
            except Exception:
                # Silent: network blips, bot down temporarily, etc. Runner is best-effort.
                pass
            time.sleep(self.interval)

    def stop(self):
        self._running = False
