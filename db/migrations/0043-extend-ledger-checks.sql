-- Migration 0043: extend activity-ledger event and signal types.
-- Spec: specs/020-session-start-weight-failed/SPEC.md (card 1, section 1).

BEGIN;

-- Migration 0041 declared these CHECKs inline without explicit names.
-- PostgreSQL generated the conventional <table>_<column>_check names below;
-- re-add them explicitly so future migrations do not have to infer them.
ALTER TABLE student_events
  DROP CONSTRAINT student_events_event_type_check;
ALTER TABLE student_events
  ADD CONSTRAINT student_events_event_type_check CHECK (
    event_type IN ('session_completed', 'session_partial', 'pr_e1rm', 'set_failed')
  );

ALTER TABLE student_signals
  DROP CONSTRAINT student_signals_signal_type_check;
ALTER TABLE student_signals
  ADD CONSTRAINT student_signals_signal_type_check CHECK (
    signal_type IN ('missed_training', 'pr_congrats', 'weight_failed')
  );

COMMIT;
