# User-visible performance contract

Gyro optimizes the complete local task journey, not isolated implementation
details. Performance work should record a before/after measurement for at least
one of these boundaries:

| Boundary                            | Measurement                                                               |
| ----------------------------------- | ------------------------------------------------------------------------- |
| Launch to usable composer           | wall time and blocking startup operations                                 |
| Send to visible provider activity   | median and slowest observed latency                                       |
| Provider event to rendered activity | latency, duplicates, and missing sequence gaps                            |
| Project open to usable workspace    | Git scans, filesystem scans, and main-thread blocking                     |
| Review open for a large change      | wall time, rendered files, and memory growth                              |
| Stop or app close                   | provider/terminal drain time and leaked child processes                   |
| Restart and resume                  | transcript recovery, active-state reconciliation, and time to usable chat |

## Release journey

The acceptance journey is:

1. Launch a release build on a clean macOS account.
2. Open a project and connect one provider through provider-owned login.
3. Send a goal and observe the first provider activity.
4. Observe browser, terminal, file, and approval activity without switching
   mental models between surfaces.
5. Review the change and run or preview the result.
6. Restart Gyro and resume with the transcript, decisions, and next step intact.

Record failures by boundary. A static source check can protect an invariant but
does not count as a runtime latency or clean-machine measurement.
