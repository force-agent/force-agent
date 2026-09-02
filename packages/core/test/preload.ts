process.env.OPENCODE_DB = ":memory:"
// power-agent overlay: `OPENCODE_MODELS_PATH` used to be set here as well,
// pointing at test/plugin/fixtures/models-dev.json. It was inert — the layer only
// ever read `options.file` — but now that models-dev.ts falls back to the env
// (POWER_MODELS_PATH / OPENCODE_MODELS_PATH) it would redirect *every* catalog in
// the suite to that 3-provider fixture, including the tests that assert on KV
// entries and on fetched bodies. Tests that want the fixture pass `file`
// explicitly; see test/plugin/models-dev.test.ts.
// `DISABLE_MODELS_FETCH` stays: it was inert too, and now it actually keeps a
// default-constructed `ModelsDev.node` from forking a background fetch.
process.env.OPENCODE_DISABLE_MODELS_FETCH = "true"
