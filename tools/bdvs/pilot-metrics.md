# BDVS Pilot – Metrics and Baseline

**Purpose:** agree, before the pilot starts, the numbers that will decide whether BDVS goes live. Fill the baseline from the current paper process **before** the first pilot batch, or there is nothing to compare against.

## 1. The four metrics

| # | Metric | How it is measured | Baseline (paper) | Target for go-live |
|---|---|---|---|---|
| M1 | **% of batches with both documents verified within 3 calendar days of dispatch** | Count of batches where BMR/BPR *and* COA reached "Verified OK" ≤ 3 days after dispatch ÷ batches dispatched | ____ % | ≥ [85] % |
| M2 | **% of documents uploaded/submitted within 2 days of dispatch** | Documents with first upload before the deadline ÷ all documents ("Late (h)" column = 0 in the export) | ____ % | ≥ [90] % |
| M3 | **Average QA verification turnaround (working hours per document)** | Mean of "working h" recorded at each accept/reject decision | ____ h | ≤ 24 h, no breaches |
| M4 | **Average days dispatch → batch closed** (hardcopies in, BDV completed) | Mean of (closure date − dispatch date) per closed batch | ____ days | ≤ [7] days |

Secondary (watch, no target yet): rejection rate per department, number of out-of-limit findings caught, number of reminder escalations sent.

> Numbers in [brackets] are proposals — confirm them in the team meeting.

## 2. Baseline capture (QA, ~1 hour, from the current registers)

Take the **last 15 dispatched batches** before the pilot and fill this table from the paper records:

| Batch No. | Dispatch date | BMR received by QA on | COA received by QA on | QA review completed on | Days dispatch→review done | Both within 3 days? (Y/N) |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | |

*(15 rows; a date that was never recorded is itself a finding — write "not recorded", and count that batch as "N" in the last column.)*

From the table: M1 = count(Y)/15 · M2 = documents received ≤2 days / 30 · M3/M4 = averages of the last two columns. Sign and date the sheet; it becomes an annexure of the pilot report.

## 3. Where the "after" numbers come from

No extra work during the pilot — BDVS records everything:

- **Dashboard → Export batch register (Excel CSV):** per document — upload due date, first upload, *Late (h)*, verified-on, hardcopy received, batch closed. M1, M2 and M4 come straight from these columns.
- **Verification turnaround (M3):** the "working h" value stored with every decision (visible per version in the batch view; also in the audit-trail export).
- **Reports tab:** out-of-limit / out-of-trend counts for the secondary metrics.

## 4. Pilot rules

1. Pilot size: **[20] consecutive dispatched batches** (or [4] weeks, whichever is later) — confirm in the meeting.
2. Paper process continues in parallel; BDVS is the tracked copy. Nothing is released on BDVS data alone during the pilot.
3. Weekly 15-minute review (QA + one person per department): the four metrics, plus anything that blocked someone.
4. Every workaround or complaint is written down — each becomes a setting, a checklist change or a fix before go-live.
5. At pilot end, QA compares baseline vs pilot numbers in a one-page pilot report and recommends go/no-go. The same report seeds the PQ summary.

## 5. Decision record

| Item | Decision | Date | By |
|---|---|---|---|
| Baseline captured (Section 2 attached) | | | |
| Targets confirmed (M1–M4) | | | |
| Pilot start / size | | | |
| Go-live decision | | | |
