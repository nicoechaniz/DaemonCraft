# ChatFilter — Spanish Wordlist

The ChatFilter plugin (Modrinth `chatfilter-zepsizola`) installs with an
EN-only sample. `wordFilters-es.yml` here is a tight ES floor: common
strong-profanity (soft-block / replace with `****`) plus a smaller
zero-tolerance group-slur list (hard-block).

## Install

ChatFilter doesn't (yet) support an `include:` directive, so the entries
need to live in the plugin's main `wordFilters.yml`. The recommended path
is the installer script:

```bash
scripts/install-chatfilter-es.sh
```

It detects whether the entries are already merged (idempotent — uses an
`AddedBy: DC-131` sentinel), appends them if not, and restarts minecraft
so ChatFilter rebuilds its filter set. Re-running on an already-installed
server is a no-op.

If you'd rather do it by hand, the script is short and the manual paths
below are equivalent.

**A) One-time copy** — append the `ChatFilter:` children to the plugin's
existing file:

```bash
docker cp server/plugins/chatfilter/wordFilters-es.yml \
  daemoncraft-minecraft:/data/plugins/ChatFilter/wordFilters-es.yml.staging
docker exec -u 1000 daemoncraft-minecraft sh -c \
  'grep -A 999 "^ChatFilter:" /data/plugins/ChatFilter/wordFilters-es.yml.staging \
   | tail -n +2 >> /data/plugins/ChatFilter/wordFilters.yml'
docker exec -u 1000 daemoncraft-minecraft mc-send-to-console "chatfilter reload"
```

**B) Replace** — if you're starting from the default file and don't need
the EN samples:

```bash
cp server/plugins/chatfilter/wordFilters-es.yml \
  server/data/plugins/ChatFilter/wordFilters.yml
docker exec -u 1000 daemoncraft-minecraft mc-send-to-console "chatfilter reload"
```

`server/data/` is gitignored, so the live file isn't tracked here. This
directory holds the canonical authored source.

## Tuning

- The strong-profanity list uses `\w*` after the root to catch conjugations
  (`putada`, `mierdoso`) but `\b` on the left to avoid catching innocuous
  prefixes (`disputa`, `inmiscuirse`).
- Group slurs are deliberately narrow — false positives here would be much
  worse than missed catches. Widen only after an incident review surfaces
  a specific gap.
- Soft-block uses `Replace: true` + `Cancel: false` so the message still
  reaches chat with the offending word as `****`. Hard-block uses `Cancel:
  true` so the line never appears.

## Future

If repeated offenders need automated escalation (mute, kick), add a
LiteBans hook in `Action:` blocks. Out of scope today.
