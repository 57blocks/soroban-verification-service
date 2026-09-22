#!/usr/bin/env node
/** Builds the composition template this verifier currently uses and proves the result can run. */

import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TEMPLATE_ROOT = join(ROOT, "docker/composed-environments");

/** The image this template claims to mirror. */
const OFFICIAL_CLI_IMAGE = "docker.io/stellar/stellar-cli:latest";

/** The pair the gate composes when none is given. */
const DEFAULT_PAIR = {
  cliver: "23.2.1#496ac35be7a7d8d923fcde9bbbc650ee593d1f6f",
  rsver: "1.90.0",
};

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

async function main() {
  // Imported from the built output, like every other consumer in this repository.
  const { CURRENT_COMPOSE_TEMPLATE_VERSION } = await import("../packages/core/dist/src/index.js");
  const composer = "../services/composer/dist/modules/composer";
  const { loadCompositionTemplate, templateDirFor } = await import(`${composer}/template.js`);
  const { fetchAndVerifyComponents } = await import(`${composer}/components.js`);
  const { buildComposedImage, smokeTestComposedImage } = await import(`${composer}/image.js`);

  const templateVersion = arg("template-version", CURRENT_COMPOSE_TEMPLATE_VERSION);
  const pair = { cliver: arg("cliver", DEFAULT_PAIR.cliver), rsver: arg("rsver", DEFAULT_PAIR.rsver) };
  // Not a real environment id — nothing here is persisted or published. It only names the local tag.
  const environmentId = `template-gate-${templateVersion}`;

  console.log(`template_version : ${templateVersion}`);
  console.log(`pair             : ${pair.cliver} / ${pair.rsver}`);

  const template = await loadCompositionTemplate(TEMPLATE_ROOT, templateVersion);
  console.log(`platform         : ${template.platform}`);
  console.log(`base_image       : ${template.baseImage.reference}@${template.baseImage.digest}`);
  console.log(
    `runtime libs     : ${
      template.runtimeLibraries.length === 0
        ? "(none)"
        : template.runtimeLibraries.map((l) => `${l.name} ${l.version}`).join(", ")
    }`,
  );

  // Both halves have to agree, and neither file can see the other.
  await assertDockerfileInstallsEveryPin(templateVersion, template);
  console.log("✓ every runtime_libraries pin has a matching COPY, and no COPY is unpinned");

  // The two checks above need no Docker, no network, and ~no time — so they are worth running on every push,
  // while the build below is path-filtered.
  if (process.argv.includes("--pins-only")) {
    console.log(`\n✓ Template ${templateVersion} is internally consistent (pins-only mode; nothing built).`);
    return;
  }

  const workdir = await mkdtemp(join(tmpdir(), "template-gate-"));
  const contextDir = join(workdir, "context");
  await mkdir(contextDir, { recursive: true });

  try {
    console.log("\n— fetching and verifying components (real checksums, real sources) —");
    const { components } = await fetchAndVerifyComponents({
      pair,
      template,
      contextDir,
      timeoutMs: 300_000,
    });
    for (const component of components) {
      console.log(`  ${component.kind.padEnd(16)} ${component.sha256}  ${component.source}`);
    }

    console.log("\n— building the composed image —");
    await buildComposedImage({
      environmentId,
      pair,
      template,
      templateDir: templateDirFor(TEMPLATE_ROOT, templateVersion),
      contextDir,
      timeoutMs: 1_800_000,
    });

    console.log("\n— smoke-testing it, exactly as the composer does —");
    const smokeTest = await smokeTestComposedImage({ environmentId, pair, timeoutMs: 300_000 });
    console.log(`  rustc   : ${smokeTest.reported_rsver}`);
    console.log(`  stellar : ${smokeTest.reported_cliver.replace(/\n/g, "\n            ")}`);

    if (!smokeTest.matches_pair) {
      // Thrown rather than exited, so the `finally` below still runs — see the catch's note.
      throw Object.assign(
        new Error(
          `the composed image does not report the pair it was asked to produce (requested ` +
            `${pair.cliver} / ${pair.rsver}); the composer would refuse to push it`,
        ),
        { reason: "smoke_test_disagreed" },
      );
    }
    console.log(`\n✓ Template ${templateVersion} composes and reports the pair it was asked for.`);

    await assertRuntimeSurfaceMatchesOfficial(environmentId);

    if (!process.argv.includes("--no-contract-build")) {
      await assertBuildsAContract(environmentId);
    }

    console.log(`\n✓ Template ${templateVersion} is usable.`);
  } catch (error) {
    // `ComponentError`/`ImageError` carry the reason that would have reached the receipt.
    const reason = error?.reason ? ` [${error.reason}]` : "";
    console.error(`\n✗ Template ${templateVersion} failed${reason}: ${error?.message ?? error}`);
    if (error?.context?.detail) console.error(`\n${error.context.detail}`);
    // `process.exitCode`, never `process.exit()`: the latter terminates synchronously without unwinding, so the
    // `finally` below would not run and every failing run would leave ~110 MB of verified components in the
    // temp dir plus an unusable image on the daemon.
    process.exitCode = 1;
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => undefined);
    if (!process.argv.includes("--keep-image")) {
      // The runner moved out of `services/composer` and into `@scvs/core`; both reach this script through
      // built output, so the path follows it rather than the package specifier.
      const { runCommand } = await import("../packages/core/dist/src/process.js");
      await runCommand(["docker", "image", "rm", "-f", `scvs-composed:${environmentId}`], {
        timeout_ms: 60_000,
        mirrorOutput: false,
      }).catch(() => undefined);
    }
  }
}

/** Asserts the composed image's *docker-level* runtime surface, the part `stellar version` cannot see. */
async function assertRuntimeSurfaceMatchesOfficial(environmentId) {
  const { runCommand } = await import("../packages/core/dist/src/process.js");

  console.log("\n— comparing the docker-level runtime surface against the official image —");
  const format = "{{json .Config.Entrypoint}}\t{{json .Config.Cmd}}\t{{.Config.WorkingDir}}";

  const inspect = async (image) => {
    const result = await runCommand(["docker", "inspect", "--format", format, image], {
      timeout_ms: 120_000,
      mirrorOutput: false,
    });
    if (result.exit_code !== 0) return undefined;
    const [entrypoint, cmd, workdir] = result.stdout.trim().split("\t");
    return { entrypoint, cmd, workdir };
  };

  // Pulled rather than assumed present; the surface being compared to is the thing this template claims to
  // mirror, so reading it from the actual image is the point.
  const pull = await runCommand(["docker", "pull", "-q", OFFICIAL_CLI_IMAGE], {
    timeout_ms: 900_000,
    mirrorOutput: false,
  });
  if (pull.exit_code !== 0) {
    // A warning, not a failure: this comparison must not turn a Docker Hub outage into a red gate on our own
    // template.
    console.warn(
      `  ⚠ could not pull ${OFFICIAL_CLI_IMAGE} to compare against; skipping the surface comparison`,
    );
    return;
  }

  const official = await inspect(OFFICIAL_CLI_IMAGE);
  const composed = await inspect(`scvs-composed:${environmentId}`);
  if (!official || !composed) {
    console.warn("  ⚠ could not inspect one of the images; skipping the surface comparison");
    return;
  }

  console.log(`  official : entrypoint=${official.entrypoint} cmd=${official.cmd} workdir=${official.workdir}`);
  console.log(`  composed : entrypoint=${composed.entrypoint} cmd=${composed.cmd} workdir=${composed.workdir}`);

  const differences = [];
  // ENTRYPOINT and WORKDIR must match: the builder's `docker run <image> <bldarg…>` depends on both.
  if (composed.entrypoint !== official.entrypoint) {
    differences.push(`entrypoint ${composed.entrypoint} != official ${official.entrypoint}`);
  }
  if (composed.workdir !== official.workdir) {
    differences.push(`workdir ${composed.workdir} != official ${official.workdir}`);
  }
  // CMD is compared as "carries no inherited command", not for equality: the official image has none, and
  // `buildpack-deps` leaves `["bash"]` behind, which ENTRYPOINT does not clear.
  if (composed.cmd !== "null" && composed.cmd !== "[]") {
    differences.push(`cmd ${composed.cmd} should be empty, as the official image's is`);
  }

  if (differences.length > 0) {
    throw Object.assign(
      new Error(`the composed image's runtime surface differs from the official image: ${differences.join("; ")}`),
      { reason: "runtime_surface_differs" },
    );
  }
  console.log("  ✓ entrypoint, workdir and cmd match the official image");
}

/** Compiles an actual Soroban contract inside the composed image. */
async function assertBuildsAContract(environmentId) {
  const { runCommand } = await import("../packages/core/dist/src/process.js");

  console.log("\n— compiling a scaffolded contract in it (proves the toolchain works, not just runs) —");
  const build = await runCommand(
    [
      "docker",
      "run",
      "--rm",
      // Since template v3 the image declares `ENTRYPOINT ["stellar"]` to mirror the official one, so `docker
      // run <image> sh -c …` becomes `stellar sh -c …` → "unrecognized subcommand 'sh'".
      "--entrypoint",
      "sh",
      `scvs-composed:${environmentId}`,
      "-c",
      // `-e` so a failing `init` cannot be papered over by a later command succeeding.
      "set -e; " +
        "stellar contract init /tmp/probe >/dev/null; " +
        "cd /tmp/probe; " +
        "stellar contract build; " +
        "find target -name '*.wasm' -size +1c",
    ],
    { timeout_ms: 1_800_000 },
  );

  if (build.exit_code !== 0 || !/\.wasm/.test(build.stdout)) {
    throw Object.assign(
      new Error(
        "the composed image reports the right toolchain but cannot compile a contract in it" +
          (build.timed_out ? " (timed out)" : ""),
      ),
      { reason: "composed_image_cannot_build", context: { detail: excerptOf(build) } },
    );
  }

  const wasm = build.stdout.trim().split("\n").filter((line) => line.endsWith(".wasm"));
  console.log(`  emitted: ${wasm.join(", ") || "(none reported)"}`);
}

/** Same stderr-first, bounded shape the composer's own diagnostics use. */
function excerptOf(result) {
  const text = (result.stderr || result.stdout || result.error || "").trim();
  return text.length > 2_000 ? `${text.slice(0, 2_000)}...` : text;
}

/**
 * Every `runtime_libraries` pin has a matching `COPY <name>.deb` in the same template's Dockerfile, and every
 * such `COPY` has a matching pin.
 */
async function assertDockerfileInstallsEveryPin(templateVersion, template) {
  const { readFile } = await import("node:fs/promises");
  const dockerfile = await readFile(
    join(TEMPLATE_ROOT, templateVersion, "Dockerfile"),
    "utf8",
  );

  const copied = new Set(
    [...dockerfile.matchAll(/^COPY\s+(\S+)\.deb\s/gm)].map((match) => match[1]),
  );
  const pinned = new Set(template.runtimeLibraries.map((library) => library.name));

  const missing = [...pinned].filter((name) => !copied.has(name));
  const orphaned = [...copied].filter((name) => !pinned.has(name));

  if (missing.length > 0) {
    throw Object.assign(new Error(`template.json pins ${missing.join(", ")} but the Dockerfile never COPYs it`), {
      reason: "template_pin_not_installed",
    });
  }
  if (orphaned.length > 0) {
    throw Object.assign(new Error(`the Dockerfile COPYs ${orphaned.join(", ")}.deb but template.json pins no such package`), {
      reason: "dockerfile_copies_unpinned_file",
    });
  }
}

await main();
