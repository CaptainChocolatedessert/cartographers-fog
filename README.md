# Cartographer's Fog

An [Owlbear Rodeo](https://www.owlbear.rodeo/) extension that adds **persistence** to dynamic
fog, rendered as a hand-drawn sepia map sketch of previously-explored terrain.

Owlbear's native Dynamic Fog extension does real line-of-sight, but it has no memory — walk
away from a room and it goes dark again. Cartographer's Fog remembers, and instead of simply
leaving the map revealed it leaves behind a squiggly sepia line drawing traced from the map
itself. The effect should read as if the party is sketching a map as they explore.

- Areas in direct line of sight show the real map
- Areas previously seen but not currently visible show only the sketch
- Areas never visited stay fully fogged

## Status

**In development, not yet installable.** The scaffold builds and loads in a real Owlbear room,
but it is headless and does nothing visible yet — it only asserts that it can read map pixels.
See [DESIGN.md](DESIGN.md) for the architecture and the build order.

## Installation

Not yet installable. Once there is a release, the extension is added in Owlbear Rodeo via
**Add Extension** using the manifest URL:

```
https://captainchocolatedessert.github.io/cartographers-fog/manifest.json
```

Cartographer's Fog is a companion to Dynamic Fog, not a replacement for it — install both.

## Development

Requires Node.js 22 or newer.

```bash
npm install
```

Two local servers, both development-only. Run each in its own terminal:

```bash
npm run devlog
```

```bash
npm run dev
```

`devlog` receives log output on port 9999 and appends it to `dev.log`; `dev` is the Vite
dev server on port 5173. Then in Owlbear Rodeo, **Add Extension** with:

```
http://localhost:5173/cartographers-fog/manifest.json
```

The extension is headless — it registers no toolbar UI yet, so a successful load shows
*nothing* in the Owlbear interface. Confirm it is running by watching `dev.log`, which should
report the background page becoming ready and the CORS probe passing.

Opening the dev server directly in a browser runs the code but leaves the SDK inert
(`OBR.isAvailable === false`), since it is not embedded by Owlbear.

```bash
npm test
```

```bash
npm run build
```

`test` runs the vitest suites; `build` type-checks and emits a production build to `dist/`.
Most of the difficult logic here is pure and headless by design, so the tests are the primary
development loop — see the testing strategy in [DESIGN.md](DESIGN.md).

Deployment is automatic: pushing to `main` triggers a GitHub Actions workflow that runs the
tests, builds, and publishes to
<https://captainchocolatedessert.github.io/cartographers-fog/>.

## License

**GNU GPLv3.** See [LICENSE](LICENSE).

Cartographer's Fog runs alongside
[`owlbear-rodeo/dynamic-fog`](https://github.com/owlbear-rodeo/dynamic-fog) and reads the walls
and lights it places, but it shares no code with it and is not a derivative work — GPLv3 is
chosen here, not inherited. Map ingestion is expected to be handled by the separate
[`Eppinguin/uvtt-importer`](https://github.com/Eppinguin/uvtt-importer) extension rather than
reimplemented here.
