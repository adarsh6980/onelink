# Demo video script (~30 seconds, screen capture + captions)

The recorded demo (`onelink-demo.mp4`) walks through the split-a-receipt flow end
to end on a local build. It uses only generated sample receipts
(`scripts/samples/`), never a real document.

## Scene list

1. **Home page (3s)** - "OneLink Intake - split a shared receipt from one photo.
   No accounts on either side." Shows the intake form and the split drop zone.
2. **Upload (2s)** - "Drop a receipt photo. Everything runs on this machine."
   A generated Lidl sample receipt is dropped into the split drop zone.
3. **Extraction (4s)** - "Local PP-OCRv4 neural OCR reads the items - no cloud
   model." The split page shows the read items, the receipt total and the engine
   note ("Items read by rapidocr-local..."). The item sum is shown against the
   receipt total.
4. **Assignment (4s)** - "People choose who shares each item. The AI never
   assigns ownership." Names are entered, the payer is chosen, and each item is
   ticked for the people who share it. The model only reads; people decide.
5. **Confirmation gate (3.5s)** - "A person confirms the receipt total before
   the split is final." The provisional preview and the manual-check prompt are
   shown; matching sums alone do not finalize anything.
6. **Result (4s)** - "Deterministic cent arithmetic computes shares - no model
   in the money path." Final per-person shares with the confirmation line:
   split total matches the receipt total, every item assigned.
7. **CSV export (4s)** - "Reconciliation - the split total must match the
   receipt total before export." The exported CSV includes per-item assignments,
   per-person shares and a reconciliation row.
8. **Architecture card (5s)** - closing card: PP-OCRv4 neural OCR + classical
   fallback, no external model API; people choose ownership; deterministic
   cent arithmetic; human confirmation gate + reconciliation; Node.js with
   JSON file storage on one VM, no external services.

## How it was produced

- `scripts/demo.sh` seeds the local app; the split flow itself needs no seeding.
- The browser is driven through the real UI (no mocked screens): upload a sample
  via the split drop zone, wait for extraction, fill names/payer, tick items,
  save, confirm, export.
- Captions are burned in; there is no voiceover. All receipts shown are
  generated samples, not real documents.

## If a voiceover is wanted later

The eight captions above double as the narration lines, in order. Total runtime
is ~30 seconds.
