# Windows native media v2 resource ownership

No v2 media resources exist yet. Add a row before introducing each resource or callback-producing subsystem; a resource without one explicit owner is not ready to implement.

| Resource | Owner object | Owner thread | Created at | Destroyed at | Cancellation | May outlive session? |
| --- | --- | --- | --- | --- | --- | --- |
| _Template: concrete resource_ | _Single owning object_ | _Named thread/apartment_ | _Initialization stage_ | _Ordered teardown stage_ | _Signal and bounded wait_ | _Yes/No with reason_ |

## Rules

- One object owns creation and destruction; observers may borrow but cannot release or replace the resource.
- The owner thread and COM apartment are fixed before creation, and destruction runs on that thread unless the underlying API explicitly guarantees otherwise.
- Cancellation is idempotent, callbacks are fenced before dependent resources are destroyed, and every wait has a documented deadline and escalation path.
- A resource may outlive a voice session only when its lifetime is deliberately process-scoped and its reset semantics are tested.
