# Local commit validation

The commit was prepared against `55191294bee88b1d07fb9a827ae11a600b616180`.
Only this chat's hardware-resource scheduling, native-listener and editor-retention
changes, associated checks and measurements are included. Shared files were
selected by change, leaving unrelated work in the working tree.

A disposable source snapshot contains that HEAD plus only the selected changes.
Installed dependencies were reused, with the desktop workspace package resolved
to the snapshot's UI source. The following passed against that isolated snapshot:

- Desktop TypeScript check.
- Editor resource lifecycle, including 200 previews and dirty/shared/reopen safety.
- Resource scheduling counts for usage, Explorer and language sessions.
- All 14 editor language-session behaviors.
- Page reliability and foreground/background polling behavior.
- Composer usage identity, ordering, context usage and context peak checks.
- Explorer invalidation, coalescing and hidden-window cleanup.

The guard registry fails identically in the untouched HEAD and selected snapshot:
`check-activity-composer-browser.mjs` and `check-capability-lifecycle.mjs` have no
reachable runner. Both snapshots also lack verification-map entries for those two
checks and `check-sidebar-project-groups.mjs`. These baseline issues were left to
their owning changes. All three new resource guards have runner paths and map
entries. The earlier registry pass in the audit reports applies to the full,
shared working tree, which contains other uncommitted registry fixes.

The native listener tests and development/frozen browser measurements described
in the audit reports were run earlier in the shared working tree. Native tests
and browser measurements were not repeated against this selected commit snapshot.
No release build, installation or publication is part of this commit.
