# Multi Package Workspace Differential Fixture

Two contract members share one path dependency with different feature sets. Dropping a recorded
`--package` changes feature unification and can change the emitted Wasm bytes.
