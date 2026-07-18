# Approval gate example

`delete_example_marker` demonstrates a native confirmation boundary around one fixed workspace action. It deletes only a regular `.rigyn-approval-example` file, verifies the file identity and metadata again after the dialog, checks cancellation before mutation, preserves stale or declined actions, and fails closed when the host has no interactive UI.

From this directory:

```sh
node --test activation.test.mjs
rigyn install .
touch .rigyn-approval-example
rigyn --tools delete_example_marker -p "Delete the example marker."
rigyn remove approval-gate-example
```

Do not replace the native confirmation with a model-controlled boolean. A production package should keep the same fail-closed rule and narrow the approved action to its actual authority boundary.
