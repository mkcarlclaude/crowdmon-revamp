-- The five classes v2 pre-labels against (M12.3, decided 2026-08-08).
--
-- Seeded as a migration rather than typed into production by hand, for the
-- reason M1 exists: the account has to be rebuildable from nothing, and a
-- `classes` table whose contents live only in somebody's shell history is a
-- dependency no `terraform apply` can reproduce. It also means the wording
-- below arrives through a reviewed diff, which matters more here than it
-- looks — an appearance prompt is not configuration, it is the thing the
-- detector actually matches on, so changing one silently changes what every
-- prediction after it means.
--
-- ROADMAP.md M11 calls these "prompts that were seeded by hand", and this is
-- that seeding. M12 is what makes them editable without a deploy; until then
-- a reworded prompt is another migration, which is the correct friction for
-- the one table where a careless edit is indistinguishable from a model
-- getting worse.
--
-- Why descriptions and not names
-- --------------------------------
-- Open-vocabulary detectors match described appearance, not proper nouns
-- (CONTEXT.md §12). "Paimon" means nothing to OWL-ViT; "a small white-haired
-- floating fairy companion" is something it can actually ground. `name` is
-- therefore the label a human reads and joins on, and `appearance_prompt` is
-- the only field the model ever sees — which is exactly why they are two
-- columns and not one.
--
-- Chosen on visual separability and on appearing in footage that can actually
-- be obtained (M12.3). The separability argument, briefly, because it is the
-- reason these five and not five others: Paimon is tiny and floats, Aether is
-- the only blond male, Raiden is unmistakably purple, Kazuha is white-haired
-- with red accents, and Hu Tao is dark twin-tails under a hat. Two of them
-- have pale hair, which is the closest call here — Paimon's size and floating
-- pose are what keep that pair apart, and if the accept rate says otherwise
-- then M12.2's dry-run against a sample of frames is where that gets found,
-- before a reworded prompt has pre-labelled anything.
--
-- These are first drafts and are expected to be wrong. Nothing about this
-- file claims the wording is good — only that it is recorded, versioned, and
-- changed deliberately. `prompt_version` is stamped onto every prediction
-- these produce, so the day one is reworded, the boxes from before and after
-- stay tellable apart instead of silently becoming one mixed regime.

INSERT INTO classes (name, appearance_prompt, prompt_version, active) VALUES
  ('Paimon',
   'a small white-haired floating fairy companion with a dark crown and a white cape',
   '2026-08-08-a', 1),

  ('Aether',
   'a blond-haired young man with a single long braid, in a dark outfit with gold trim',
   '2026-08-08-a', 1),

  ('Raiden Shogun',
   'a woman with long purple hair in a braid, in a purple and violet kimono',
   '2026-08-08-a', 1),

  ('Kazuha',
   'a young man with short white hair with a red streak, in a red and white haori',
   '2026-08-08-a', 1),

  ('Hu Tao',
   'a girl with dark brown twin-tails with red tips, in a black and red coat with a flower-shaped hat',
   '2026-08-08-a', 1);
