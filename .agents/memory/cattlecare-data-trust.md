---
name: CattleCare data trust
description: User-defined boundaries for presenting sensor readings, sample values, connections, and cattle health alerts.
---

Show a reading as live only when it came from a successful ThingSpeak feed response. Clearly label illustrative sample values, distinguish planned/manual connection status from verified feed access, and do not present threshold alerts as a diagnosis or forecast unless a validated prediction model is actually implemented.

**Why:** CattleCare is a college prototype for dairy farms; the user explicitly requires that its demo not imply unverified hardware or veterinary conclusions.

**How to apply:** Preserve these boundaries in dashboards, animal histories, alerts, and future sensor integrations.
