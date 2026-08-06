# extensions.disabled

Empty quarantine folder. Used briefly for **pi_agent_rust** (PiJS cannot load Node npm imports).

As of 2026-08-05, canonical `pi` is again the **giiyms/pi** TypeScript fork; all extensions live in `../extensions/`.

If you ever need to quarantine again:

```sh
mv ~/.pi/agent/extensions/<name> ~/.pi/agent/extensions.disabled/
```
