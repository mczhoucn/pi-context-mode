# Journal - gxg (Part 1)

> AI development session journal
> Started: 2026-09-08

---



## Session 1: Configurable Pi native tool replacements
<!-- trellis-session: v=2 fp=dfbea69f7d83bae0 -->

**Date**: 2026-09-08
**Task**: Configurable Pi native tool replacements
**Branch**: `dev`

### Summary

Delivered independent default-off Bash routing and bounded native Read, with configurable source limits, conflict warnings, tests, documentation, and an independent Trellis review.

### Main Changes

- Added toolReplacements settings; Read defaults to 300 source lines / 10240 UTF-8 bytes, with native images and accurate continuation.
- Kept native Bash as a recovery channel; synchronized Pi ctx descriptions and preserved third-party tool owners.

### Git Commits

| Hash | Message |
|------|---------|
| `5901a6c1` | feat(pi): add opt-in native tool replacements |

### Testing

- [OK] 236 focused tests across 11 files passed; typecheck and build passed.
- [OK] 43 real Pi 0.85.1 bundled/unbundled loader and AgentSession registry checks passed with zero model requests.

### Status

[OK] **Completed**

### Next Steps

- Existing Bootstrap Guidelines task and unrelated Trellis initialization changes remain untouched.


## Session 2: Configurable Pi built-in feature suppression
<!-- trellis-session: v=2 fp=43693f037931c3ec -->

**Date**: 2026-09-23
**Task**: Configurable Pi built-in feature suppression
**Branch**: `downstream`

### Summary

Shipped disabledBuiltinFeatures for Pi: default-hide five administrative tools, optional compactRecovery gate, host-owned catalog filtering, tests, README/spec, Trellis host wiring, and local-tmp gitignore.

### Git Commits

| Hash | Message |
|------|---------|
| `e55139b6` | feat(pi): add configurable built-in feature suppression |
| `806263f6` | chore: ignore local tmp files and host runtime dumps |
| `8f395c21` | chore: add Trellis workflow files and Pi/OMO host wiring |
| `b828321f` | chore: merge Trellis journals with union |

### Status

[OK] **Completed**
