# Machines TODO — Visually 3D Gallery

Tracking list for the 12 open-source / historically notable machines queued
for addition to the gallery. Each entry maps to a `public/samples/<slug>.json`
file plus a registration in `public/samples/index.json`.

Schema constraints (see `docs/schema.json`): shape must be one of
`box | cylinder | sphere | complex`. Specs sometimes suggest `cone`, `dish`,
or `plane` — approximate those with the supported primitives (a cone
becomes a thin cylinder or sphere; a dish becomes a flat cylinder; a plane
becomes a thin box).

## Queue

- [x] **CEB Press** ("The Liberator") — OSE compressed-earth-block press.
      https://wiki.opensourceecology.org/wiki/CEB_Press — CC BY-SA 4.0.
      Slug: `ceb-press`.
- [x] **LifeTrac Tractor** — OSE modular open-source tractor (GVCS).
      https://www.opensourceecology.org/portfolio/tractor/ — CC BY-SA 4.0.
      Slug: `lifetrac`.
- [x] **50 kW Wind Turbine** — OSE horizontal-axis turbine on lattice tower.
      https://wiki.opensourceecology.org/wiki/Wind_Turbine — CC BY-SA 4.0.
      Slug: `wind-turbine-50kw`.
- [x] **OpenROV 2.8** — open-source underwater ROV with acrylic e-tubes.
      https://github.com/OpenROV/openrov-hardware — CC BY-NC-SA 4.0.
      Slug: `openrov-2-8`.
- [x] **Yale OpenHand Model T** — tendon-driven underactuated 4-finger hand.
      https://www.eng.yale.edu/grablab/openhand/ — CC BY-NC 3.0.
      Slug: `openhand-model-t`.
- [x] **RepRap Prusa i3 MK3S+** — the specific Prusa FDM build.
      https://reprap.org/wiki/Prusa_i3 — GFDL / GPL.
      Slug: `prusa-i3-mk3s` (the existing `3d-printer.json` is generic FDM).
- [x] **OreSat0 CubeSat** — 1U CubeSat with deployable solar panels.
      https://github.com/oresat/oresat-structure — CERN OHL v2.
      Slug: `oresat0`.
- [x] **TABBY EVO** — Open Motors EV hardware platform.
      https://www.openmotors.co/download/ — CC BY-SA 4.0.
      Slug: `tabby-evo`.
- [x] **Apollo Command & Service Module** — NASA CSM (conical CM + cylindrical SM).
      https://www.nasa.gov/history/historical-spacecraft-diagrams/ — Public Domain.
      Slug: `apollo-csm`.
- [x] **Pennsylvania Railroad S2** — 1944 experimental 6-8-6 steam-turbine loco.
      https://en.wikipedia.org/wiki/Pennsylvania_Railroad_class_S2 — CC BY-SA 4.0.
      Slug: `prr-s2`.
- [x] **MakAir open-source ventilator** — motor-driven AMBU-bag ventilator.
      https://github.com/makers-for-life/makair — Public Domain License.
      Slug: `makair`.
- [ ] **Open Bionics Hero Arm** — 3D-printed myoelectric prosthetic arm.
      https://openbionics.com/hero-arm/ — license TBC.
      Slug: `hero-arm`.

## Workflow per machine

1. Draft part list (10–15 parts) using spec as a starting point; expand
   where the prompt hints at substructure (e.g. coaxial pairs, arms,
   brackets) so the scene reads as the real machine rather than 12
   floating primitives.
2. Place parts on a coherent coordinate system — pick one axis as
   "forward" (X+) and stick with it, matching existing samples.
3. Fill `connections` to form a connected graph from root frame outward.
4. Populate `metadata.info` (japanese_name, english_name, summary,
   description, facts, sources) following the pattern in `eh216-s.json`.
5. Register in `public/samples/index.json` with a distinct accent color.
6. Tick the box in this file and update the TaskList in-session.
