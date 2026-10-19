# Historical patches — do not run on the shared project

These files are the step-by-step patches that brought the quiz's former
standalone Supabase project up to date. They target that project's `public`
schema, and some of them (for example `20260705_no_time_limit_and_logo.sql`,
which drops `questions.time_limit`) would undo later changes if replayed.

The quiz now lives in the `quiz` schema of the shared NGG Supabase project.
`../schema.sql` alone builds it there, from scratch or over an older state.
Make schema changes in `schema.sql` (idempotently, schema-qualified with
`quiz.`), never as a new file here.
