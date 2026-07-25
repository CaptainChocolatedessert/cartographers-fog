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

**Pre-implementation.** The design is settled and documented; no extension code has been
written yet. See [DESIGN.md](DESIGN.md) for the architecture, and the open questions that
still need answers.

## Installation

Not yet installable. Once there is a build, the extension is added in Owlbear Rodeo via
**Add Extension** using the manifest URL:

```
https://captainchocolatedessert.github.io/cartographers-fog/manifest.json
```

## Development

Requires Node.js.

```bash
npm install
```

```bash
npm run dev
```

The extension runs in an iframe and expects to be loaded by Owlbear Rodeo; opening the dev
server directly will render the UI but leave the SDK inert (`OBR.isAvailable === false`).

Deployment is via GitHub Pages at
<https://captainchocolatedessert.github.io/cartographers-fog/>.

## License

**GNU GPLv3.** See [LICENSE](LICENSE).

This project derives from [`owlbear-rodeo/dynamic-fog`](https://github.com/owlbear-rodeo/dynamic-fog),
Owlbear Rodeo's own open-source Dynamic Fog extension, which is likewise GPLv3. Map ingestion
is expected to be handled by the separate
[`Eppinguin/uvtt-importer`](https://github.com/Eppinguin/uvtt-importer) extension rather than
reimplemented here.
