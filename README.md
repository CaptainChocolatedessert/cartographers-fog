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

**Early, but usable.** Exploration is tracked and persisted per scene, the map is traced into
hand-drawn linework, and remembered ground is sketched behind the fog. Build order steps 0–6 are
done apart from the cross-fade, which is deferred; see [DESIGN.md](DESIGN.md).

Rough edges worth knowing before trying it:

- **Dynamic Fog must be installed too** — this extension reads the walls and lights it places.
- A scene with more than one MAP-layer image traces nothing until the GM picks one: right-click
  the map and choose **Sketch from this map**. A locked map has to be unlocked to be
  right-clickable.
- Fine linework and small text do not survive tracing at typical battlemap resolutions.
- A rotated map image is not handled — strokes will be misplaced.

### GM controls

Right-click any item as the GM. There is no settings panel yet, so these live on the context
menu:

- **Sketch from this map** — nominate which MAP image is traced. Only needed when a scene has
  more than one, and the map has to be unlocked to be right-clickable.
- **Clear sketch** — delete the sketch from this scene. Nothing is lost: it is derived from the
  map, so *Sketch from this map* redraws it whenever you want it back.
- **Reset explored area** — forget everything the party has explored in this scene. **There is
  no confirmation**, and it cannot be undone.

## Installation

Added in Owlbear Rodeo via **Add Extension** using the manifest URL:

```
https://captainchocolatedessert.github.io/cartographers-fog/manifest.json
```

Cartographer's Fog is a companion to
[Dynamic Fog](https://extensions.owlbear.rodeo/dynamic-fog), not a replacement for it.

Both extensions are added to the room, and Owlbear loads them for everyone in it — players do
not install anything separately. A client that is already connected when an extension is added
may need to reload the room to pick it up.

Each client then computes and draws its own sketch locally, from the walls Dynamic Fog places
on that machine. Nothing is pushed over the network per token move.

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
