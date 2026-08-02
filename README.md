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

**Usable, and running in real sessions.** Exploration is tracked and persisted per scene, the map
is traced into hand-drawn linework, remembered ground is sketched behind the fog, and a GM panel
handles setup and tuning. Build order steps 0–6 are done apart from the cross-fade, which is
deferred; see [DESIGN.md](DESIGN.md).

The sketch is drawn by a shader that shades each mark per screen pixel, rather than by stroking a
path — which is what allows soft edges and a weight that varies along a single stroke. Four
brushes ship: **Liner**, **Charcoal**, **Ink brush** and **Nib pen**. An optional parchment
overlay mottles everything the party cannot currently see, so the screen reads as a map on
parchment with a hole cut where they stand. The original line renderer is kept as a cheaper
fallback for clients that struggle with the shader.

Rough edges worth knowing before trying it:

- **Dynamic Fog must be installed too** — this extension reads the walls and lights it places.
- A scene with more than one MAP-layer image traces nothing until the GM picks one, in the
  panel's **Setup** tab.
- Fine linework and small text do not survive tracing at typical battlemap resolutions.
- A rotated map image is not handled — strokes will be misplaced.
- Ground the party can *currently* see is never sketched, by design. A token carrying a light
  leaves a bare patch, which fills in a moment after it moves on.
- Under the shader renderer, the redraw after a token moves is slower than panning. Switching
  **Drawing** to *Lines* trades the soft edges for speed.

## GM controls

The extension adds a button at the top left of the room, which opens the settings panel. It is
GM-only — a player who opens it is told the settings are the GM's. Three tabs:

**Setup** — configuring the scene.

- **Map to sketch** — every MAP-layer image in the scene, listed with its size and lock state.
  Only needed when a scene holds more than one, but unlike the context menu it works on a locked
  map, which is the usual state of a scene's map.
- **Mark whole map explored** — treat the entire map as already walked. Intended for judging the
  sketch, since otherwise the look can only be assessed on ground the party has covered. It does
  not clear Owlbear's own fog, which this extension does not control.
- **Clear sketch** — remove the sketch from this scene. Nothing is lost: it is derived from the
  map, so nominating a map draws it again.
- **Reset explored area** — forget everything the party has explored in this scene. Confirmed
  with a second click, and it cannot be undone.

**Appearance** — how the sketch looks: renderer, brush, and that brush's own controls, plus
colour, stroke width and the hand-drawn wobble, which are shared across brushes. Each brush keeps
its own settings, so tuning one never disturbs another, and only the controls the current
renderer actually obeys are shown. These live in *room* metadata, so they follow the GM between
scenes and reach every client automatically.

There is also a **Players can change these** switch, off by default. Turning it on gives players
the Appearance tab — and only that tab; the map, the explored area and the erase buttons stay
yours. Note these are the *table's* settings rather than each player's own, so anyone who moves a
slider changes the sketch for everybody. That is deliberate, and it is meant for handing the
controls over occasionally rather than as a per-player preference. Several people editing at once
works but is not arbitrated: changes to different controls merge, and two people on the same
control means the last one wins.

**Debug** — erase this extension's stored data, either for the scene (the explored region and the
map nomination) or for the room (appearance settings). Worth having because the data lives in the
scene and room on Owlbear's servers rather than in the extension, so removing and reinstalling it
changes nothing. Only the open scene can be reached; other scenes keep their own data.

The three original context-menu entries still ship: right-click any item as the GM for **Sketch
from this map**, **Clear sketch** or **Reset explored area**. Two differences from the panel are
worth knowing — the context-menu reset is *not* confirmed, and a locked map cannot be
right-clicked at all, which is the hole the panel was built to close.

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

A successful load puts the Cartographer's Fog button at the top left of the room. `dev.log` is
the fuller signal: it should report the background page becoming ready and the CORS probe
passing, and it carries the trace and region logs from then on. Every client in the room posts
to the same log, so lines are labelled with the role and client that wrote them.

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
