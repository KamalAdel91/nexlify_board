### Nexlify Board

Boards for any DocType on Frappe's Kanban v2. Depends on no other app.

- **Kanban on any field**: Select, Link, Data, Autocomplete or Int columns.
- **Transition Rules**: what a document needs before its stage field moves (fields, a
  Condition, an Action button, a Confirm View, Step Label, Waiting On). Checked on every save.
- **Move check**: before a Kanban drag, the document is saved as a dry run, so any validation
  (Transition Rules, Server Scripts, controllers) shows on the board with its buttons.
- **Flow**: every stage and what each one needs, from the card menu, the form, or a blocked move.
- **Actions**: `<button data-nx-action="NAME">` in any message runs `form`, `route:/app/...`,
  `map:dotted.method`, or a function in `window.nx_actions`.

### Plugging in another app (no code dependency)

Other apps connect through data on the site:

- **Nexlify Board Settings** → a row per DocType: *Check Moves* turns the move check on without
  rules; *Flow Steps Method* names a method (whitelisted Python or an API Server Script) that
  receives `doctype` and `name` and returns
  `{"steps": [{"stage", "label", "done", "action", "action_label", "waiting_on"}]}`.
- **Transition Rule → Confirm View**: a method that receives `doctype`, `name`, `to` and returns
  `{"title", "html"}`, shown with Confirm and Cancel before the move.

A move that passed the board's check carries `move.validated = true` to the other
`onBeforeCardMove` handlers, so an app's own check can skip itself.

### Setup helpers

```bash
bench --site SITE execute nexlify_board.selftest.run
bench --site SITE execute nexlify_board.setup.add_doctype --kwargs "{'doctype': 'Opportunity', 'flow_method': 'eye.flow'}"
```

#### License

mit
