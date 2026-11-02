# Postmortem: <short title>

Blameless: describe what the system and process allowed, not who made a mistake.

| | |
|---|---|
| Date / time (with timezone) | |
| Duration | |
| Severity (SEV1-3) | |
| Author / reviewers | |
| Status | draft / reviewed / actions complete |

## Summary
Two or three sentences: what broke, who was affected, how it ended.

## Impact
Users or requests affected, features down, data lost or exposed (be explicit if none), error-budget spent.

## Timeline
| Time | Event |
|---|---|
| | First sign (alert, report) |
| | Acknowledged |
| | Mitigation applied |
| | Resolved |

## Root cause
The chain of conditions that made this possible. Ask "why" five times; stop at something you can change.

## What went well / what went badly / where we got lucky

## Detection and response
How was it found? Could an alert have caught it sooner? Did the runbook help?

## Action items
| Action | Type (prevent / detect / mitigate) | Owner | Due | Done |
|---|---|---|---|---|

## Lessons and follow-up links
Logs, request ids, pull requests, related incidents.
