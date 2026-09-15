# SCV-217（service 侧）：三个部署工具支持 --contract 参数 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `sync-secrets.mjs`、`render-taskdef.mjs`、`check-taskdef-boundary.mjs` 三个工具支持新的 `--contract @<file>` 参数（优先于现有的 `process.cwd()` 拼路径读取），并让 `deploy.yml`、`deploy-builder.yml`、`deploy-composer.yml` 三个 reusable workflow 接收 ops 侧传入的 `contract_bundle`（base64 打包的 JSON），解包后把对应服务/环境的那一份写入临时文件，通过 `--contract` 传给工具。

**Architecture:** 纯新增可选参数，不改变任何现有行为路径——`--contract` 不传时完全退回旧的 `process.cwd()` 逻辑。三个工具的改动模式完全一致（复用现有 `--descriptor` 的 `@file` 语法）。三个 workflow 的改动是新增一步"从 `contract_bundle` 提取对应片段写临时文件"+ 在调用工具处追加 `--contract` 参数（仅当临时文件存在时）。

**Tech Stack:** Node.js（`eng-tools/*.mjs`，无第三方依赖，用 `node:fs`/`node:child_process`），GitHub Actions workflow YAML，jq（bash 里做 JSON 提取）。

**关联文档：** `docs/superpowers/specs/2026-09-15-scv-217-contract-injection-design.md`（本地于 `soroban-verification-ops` 仓库，未纳入该仓库版本控制；本文档复述了本仓库需要的全部细节，不需要跳转查看）
**分支：** `fix/scv-217-contract-injection-tools`（已创建，基于 service 仓库当前 main `f58816b7`）
**测试策略说明：** `eng-tools/` 下的工具历来没有单元测试（仓库测试基础设施集中在 `clients/web/`，用 vitest）。验证手段是 `node --check <file>`（语法）+ 手工构造最小场景直接跑脚本断言输出（行为），不引入新的测试框架或虚构不存在的测试目标。

---

## Task 1：`sync-secrets.mjs` 支持 `--contract`

**Files:**
- Modify: `eng-tools/sync-secrets.mjs:52-58`

- [ ] **Step 1: 查看当前实现确认行号未变**

```bash
sed -n '34,58p' eng-tools/sync-secrets.mjs
```

Expected: 看到 `const args = process.argv.slice(2);` 开始，到 `const contract = JSON.parse(readFileSync(contractPath, "utf8"));` 结束的现有实现（与本计划撰写时一致）。如果行号有出入，以实际内容为准定位，不要死板地按行号改。

- [ ] **Step 2: 替换契约读取逻辑**

将：
```javascript
const ROOT = process.cwd();
const contractPath = join(ROOT, `config/deploy/${targetEnv}/${service}.json`);
if (!existsSync(contractPath)) {
  console.error(`::error::no contract at config/deploy/${targetEnv}/${service}.json`);
  process.exit(1);
}
const contract = JSON.parse(readFileSync(contractPath, "utf8"));
```

改为：
```javascript
function loadContract() {
  const explicit = flag("contract");
  if (explicit) {
    const text = explicit.startsWith("@") ? readFileSync(explicit.slice(1), "utf8") : explicit;
    try {
      return JSON.parse(text);
    } catch (error) {
      console.error(`::error::--contract is not valid JSON: ${error.message}`);
      process.exit(1);
    }
  }
  const ROOT = process.cwd();
  const contractPath = join(ROOT, `config/deploy/${targetEnv}/${service}.json`);
  if (!existsSync(contractPath)) {
    console.error(`::error::no contract at config/deploy/${targetEnv}/${service}.json`);
    process.exit(1);
  }
  return JSON.parse(readFileSync(contractPath, "utf8"));
}
const contract = loadContract();
```

- [ ] **Step 3: 更新 usage 字符串**

将：
```javascript
if (!service) {
  console.error(
    "usage: sync-secrets.mjs --env <env> --service <name> [--descriptor <json|@file>] [--dry-run]"
  );
  process.exit(2);
}
```

改为：
```javascript
if (!service) {
  console.error(
    "usage: sync-secrets.mjs --env <env> --service <name> [--descriptor <json|@file>] [--contract <json|@file>] [--dry-run]"
  );
  process.exit(2);
}
```

- [ ] **Step 4: 语法检查**

```bash
node --check eng-tools/sync-secrets.mjs
```

Expected: 无输出，exit code 0。

- [ ] **Step 5: 手工验证向后兼容（不传 --contract 时行为不变）**

```bash
cd /tmp && mkdir -p sync-secrets-test/config/deploy/dev && cd sync-secrets-test
cat > config/deploy/dev/test-svc.json <<'EOF'
{"kind": "batch-job-definition"}
EOF
node ~/projects/Stellar/soroban-verification-service/eng-tools/sync-secrets.mjs --env dev --service test-svc
```

Expected: 输出 `test-svc is a Batch job definition — no config secret by ADR-025 decision 1 (ADR-002). Nothing to sync.`，exit code 0（走的是旧的 `process.cwd()` 路径，因为没传 `--contract`）。

- [ ] **Step 6: 手工验证 --contract 参数生效**

```bash
cd /tmp/sync-secrets-test
echo '{"kind": "batch-job-definition"}' > /tmp/explicit-contract.json
rm -rf config
node ~/projects/Stellar/soroban-verification-service/eng-tools/sync-secrets.mjs --env dev --service test-svc --contract @/tmp/explicit-contract.json
```

Expected: 同样输出 `test-svc is a Batch job definition — no config secret by ADR-025 decision 1 (ADR-002). Nothing to sync.`，exit code 0 —— 注意这次本地目录下根本没有 `config/` 目录，证明读取的确实是 `--contract` 指向的文件，不是 `process.cwd()`。

- [ ] **Step 7: 清理测试目录**

```bash
rm -rf /tmp/sync-secrets-test /tmp/explicit-contract.json
```

- [ ] **Step 8: 提交**

```bash
cd ~/projects/Stellar/soroban-verification-service
git add eng-tools/sync-secrets.mjs
git commit -m "feat(deploy): support --contract to load the deployment contract explicitly

References: #SCV-217"
```

---

## Task 2：`render-taskdef.mjs` 支持 `--contract`

**Files:**
- Modify: `eng-tools/render-taskdef.mjs:74-79`

- [ ] **Step 1: 查看当前实现**

```bash
sed -n '60,80p' eng-tools/render-taskdef.mjs
```

Expected: 看到 `const contract = (() => { ... })();` 这段现有实现。

- [ ] **Step 2: 替换契约读取逻辑**

将：
```javascript
const contract = (() => {
  try {
    return JSON.parse(readFileSync(`config/deploy/${targetEnv}/${service}.json`, "utf8"));
  } catch {
    return die(`no contract at config/deploy/${targetEnv}/${service}.json`);
  }
})();
```

改为：
```javascript
const contract = (() => {
  const explicit = flag("contract");
  if (explicit) {
    const text = explicit.startsWith("@") ? readFileSync(explicit.slice(1), "utf8") : explicit;
    try {
      return JSON.parse(text);
    } catch (error) {
      return die(`--contract is not valid JSON: ${error.message}`);
    }
  }
  try {
    return JSON.parse(readFileSync(`config/deploy/${targetEnv}/${service}.json`, "utf8"));
  } catch {
    return die(`no contract at config/deploy/${targetEnv}/${service}.json`);
  }
})();
```

- [ ] **Step 3: 更新 usage 字符串**

```bash
grep -n "usage: render-taskdef" eng-tools/render-taskdef.mjs
```

将该行：
```javascript
    "usage: render-taskdef.mjs --env <env> --service <name> --image <ref> [--descriptor @file] [--baseline @file]"
```

改为：
```javascript
    "usage: render-taskdef.mjs --env <env> --service <name> --image <ref> [--descriptor @file] [--contract @file] [--baseline @file]"
```

- [ ] **Step 4: 语法检查**

```bash
node --check eng-tools/render-taskdef.mjs
```

Expected: 无输出，exit code 0。

- [ ] **Step 5: 手工验证 --contract 生效（用 kind 校验作为可观察的行为差异）**

```bash
cd /tmp && mkdir -p render-taskdef-test && cd render-taskdef-test
echo '{"kind": "unsupported-kind"}' > /tmp/bad-contract.json
node ~/projects/Stellar/soroban-verification-service/eng-tools/render-taskdef.mjs \
  --env dev --service whatever --image 123456789012.dkr.ecr.ap-southeast-2.amazonaws.com/test@sha256:$(printf 'a%.0s' {1..64}) \
  --contract @/tmp/bad-contract.json
```

Expected: 输出 `::error::whatever is kind: unsupported-kind — this renders ECS task definitions only (ADR-025 keeps Batch on plaintext)`，exit code 1 —— 证明读取的是 `--contract` 指向的文件内容（`unsupported-kind` 这个值只存在于该文件里）。

- [ ] **Step 6: 清理测试文件**

```bash
rm -rf /tmp/render-taskdef-test /tmp/bad-contract.json
```

- [ ] **Step 7: 提交**

```bash
cd ~/projects/Stellar/soroban-verification-service
git add eng-tools/render-taskdef.mjs
git commit -m "feat(deploy): support --contract to load the deployment contract explicitly

References: #SCV-217"
```

---

## Task 3：`check-taskdef-boundary.mjs` 支持 `--contract`

**Files:**
- Modify: `eng-tools/check-taskdef-boundary.mjs:53-64`

- [ ] **Step 1: 查看当前实现**

```bash
sed -n '34,65p' eng-tools/check-taskdef-boundary.mjs
```

- [ ] **Step 2: 替换契约读取逻辑**

将：
```javascript
const ROOT = process.cwd();
const contractPath = join(ROOT, `config/deploy/${targetEnv}/${service}.json`);
if (!existsSync(contractPath)) {
  // Fail closed: no contract means nothing to check against, which is not the same as nothing to find.
  console.error(
    `::error::no deployment contract at config/deploy/${targetEnv}/${service}.json — ` +
      `cannot assert the trust boundary for a service it does not describe`
  );
  process.exit(1);
}

const contract = JSON.parse(readFileSync(contractPath, "utf8"));
```

改为：
```javascript
function loadContract() {
  const explicit = flag("contract");
  if (explicit) {
    const text = explicit.startsWith("@") ? readFileSync(explicit.slice(1), "utf8") : explicit;
    try {
      return JSON.parse(text);
    } catch (error) {
      console.error(`::error::--contract is not valid JSON: ${error.message}`);
      process.exit(1);
    }
  }
  const ROOT = process.cwd();
  const contractPath = join(ROOT, `config/deploy/${targetEnv}/${service}.json`);
  if (!existsSync(contractPath)) {
    // Fail closed: no contract means nothing to check against, which is not the same as nothing to find.
    console.error(
      `::error::no deployment contract at config/deploy/${targetEnv}/${service}.json — ` +
        `cannot assert the trust boundary for a service it does not describe`
    );
    process.exit(1);
  }
  return JSON.parse(readFileSync(contractPath, "utf8"));
}
const contract = loadContract();
```

- [ ] **Step 3: 更新 usage 字符串**

```bash
grep -n "usage: check-taskdef-boundary" eng-tools/check-taskdef-boundary.mjs
```

将该行：
```javascript
    "usage: check-taskdef-boundary.mjs --env <env> --service <name> <rendered-taskdef.json>"
```

改为：
```javascript
    "usage: check-taskdef-boundary.mjs --env <env> --service <name> [--contract @file] <rendered-taskdef.json>"
```

- [ ] **Step 4: 语法检查**

```bash
node --check eng-tools/check-taskdef-boundary.mjs
```

Expected: 无输出，exit code 0。

- [ ] **Step 5: 手工验证 --contract 生效**

```bash
cd /tmp && mkdir -p boundary-test && cd boundary-test
echo '{"kind": "ecs-service", "forbidden": {"variables": ["SECRET_FROM_EXPLICIT_CONTRACT"]}}' > /tmp/explicit-boundary-contract.json
echo '{"containerDefinitions": [{"name": "x", "environment": [{"name": "SECRET_FROM_EXPLICIT_CONTRACT", "value": "leaked"}]}]}' > /tmp/rendered.json
node ~/projects/Stellar/soroban-verification-service/eng-tools/check-taskdef-boundary.mjs \
  --env dev --service whatever --contract @/tmp/explicit-boundary-contract.json /tmp/rendered.json
```

Expected: 输出包含 `TRUST BOUNDARY: whatever must not be given SECRET_FROM_EXPLICIT_CONTRACT`，exit code 1 —— 证明 `forbidden.variables` 列表来自 `--contract` 指向的文件（`SECRET_FROM_EXPLICIT_CONTRACT` 这个变量名只存在于该文件里）。

- [ ] **Step 6: 清理测试文件**

```bash
rm -rf /tmp/boundary-test /tmp/explicit-boundary-contract.json /tmp/rendered.json
```

- [ ] **Step 7: 提交**

```bash
cd ~/projects/Stellar/soroban-verification-service
git add eng-tools/check-taskdef-boundary.mjs
git commit -m "feat(deploy): support --contract to load the deployment contract explicitly

References: #SCV-217"
```

---

## Task 4：`deploy.yml` 接收并解包 `contract_bundle`

**Files:**
- Modify: `.github/workflows/deploy.yml`（新增 `contract_bundle` input + `deploy-service` 与 `deploy-web` 两个 job 各自新增提取步骤 + 合计六处工具调用追加 `--contract`）

- [ ] **Step 1: 确认当前 workflow_call inputs 块的位置**

```bash
sed -n '11,41p' .github/workflows/deploy.yml
```

Expected: 看到 `on: workflow_call: inputs:` 下的 `source_repository`、`environment`、`source_sha`、`deploy_service`、`deploy_web` 五个现有 input。

- [ ] **Step 2: 新增 `contract_bundle` input**

在 `deploy_web` input 定义之后（`.github/workflows/deploy.yml` 第 37 行左右，`type: boolean` / `default: true` 之后，`secrets:` 块之前）插入：

```yaml
      contract_bundle:
        description: >-
          Base64-encoded JSON, shaped `{ "<env>": { "<service>": <contract> } }`, holding the deployment
          contracts the caller's repository owns for this run. Optional: when empty, each tool falls
          back to reading `config/deploy/<env>/<service>.json` from this repository's own checkout
          (the pre-SCV-217 behavior, kept for backward compatibility with callers that have not
          upgraded).
        type: string
        required: false
        default: ""
```

- [ ] **Step 3: 验证 YAML 语法**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))" && echo "YAML OK"
```

Expected: 输出 `YAML OK`。

- [ ] **Step 4: 定位 matrix job（`migrate` 之后那个部署 job，第 373 行附近）并新增契约提取步骤**

```bash
grep -n "matrix:\|service: \[verification-svc" .github/workflows/deploy.yml
```

Expected: 找到 `strategy: / fail-fast: false / matrix: / service: [verification-svc, orchestrator-svc, query-svc]` 所在行号（约 378-380，以实际为准）。

在该 job 的 `steps:` 列表中，`actions/checkout` 步骤之后、`Configure AWS credentials` 步骤之前，插入新步骤：

```yaml
      - name: Extract ${{ matrix.service }}'s deployment contract from the bundle
        if: inputs.contract_bundle != ''
        env:
          CONTRACT_BUNDLE_B64: ${{ inputs.contract_bundle }}
        run: |
          set -euo pipefail
          echo "$CONTRACT_BUNDLE_B64" | base64 -d > /tmp/contract-bundle.json
          jq -e --arg env "${{ inputs.environment }}" --arg svc "${{ matrix.service }}" \
            '.[$env][$svc] // error("no contract for " + $env + "/" + $svc + " in bundle")' \
            /tmp/contract-bundle.json > /tmp/contract.json
```

- [ ] **Step 5: 三处工具调用追加 `--contract` 参数（仅当临时文件存在时）**

```bash
grep -n "node eng-tools/sync-secrets.mjs\|node eng-tools/render-taskdef.mjs\|node eng-tools/check-taskdef-boundary.mjs" .github/workflows/deploy.yml
```

Expected: 定位到三处调用（`sync-secrets.mjs`、`render-taskdef.mjs`、`check-taskdef-boundary.mjs`，均在同一个 matrix job 内，各自的 `run:` 块里）。

对 `sync-secrets.mjs` 调用处（当前形如）：
```yaml
          node eng-tools/sync-secrets.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service "${{ matrix.service }}" \
            --descriptor @/tmp/ci-descriptor.json
```

改为在该 `run:` 块的脚本内新增条件判断，追加 `--contract` 参数：
```yaml
        run: |
          set -euo pipefail
          printf '%s' "$DESCRIPTOR" > /tmp/ci-descriptor.json
          CONTRACT_ARG=()
          if [ -f /tmp/contract.json ]; then CONTRACT_ARG=(--contract "@/tmp/contract.json"); fi
          node eng-tools/sync-secrets.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service "${{ matrix.service }}" \
            --descriptor @/tmp/ci-descriptor.json \
            "${CONTRACT_ARG[@]}"
```

对 `render-taskdef.mjs` 调用处，同样在其 `run:` 块开头加 `CONTRACT_ARG` 判断（复用同一个 `/tmp/contract.json`，因为同一个 job 内 `matrix.service` 不变），并在调用行末尾追加 `"${CONTRACT_ARG[@]}"`：
```yaml
        run: |
          set -euo pipefail
          CONTRACT_ARG=()
          if [ -f /tmp/contract.json ]; then CONTRACT_ARG=(--contract "@/tmp/contract.json"); fi
          ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
          case "$ACCOUNT" in
            [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
            *) echo "::error::could not resolve the account id (got '$ACCOUNT')"; exit 1 ;;
          esac
          node eng-tools/render-taskdef.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service "${{ matrix.service }}" \
            --image "${ACCOUNT}.dkr.ecr.${AWS_REGION}.amazonaws.com/${{ needs.stage-service-image.outputs.image_repo }}@${{ needs.stage-service-image.outputs.image_digest }}" \
            --descriptor @/tmp/ci-descriptor.json \
            "${CONTRACT_ARG[@]}" \
            > /tmp/taskdef.json
```

对 `check-taskdef-boundary.mjs` 调用处同理：
```yaml
        run: |
          CONTRACT_ARG=()
          if [ -f /tmp/contract.json ]; then CONTRACT_ARG=(--contract "@/tmp/contract.json"); fi
          node eng-tools/check-taskdef-boundary.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service "${{ matrix.service }}" \
            "${CONTRACT_ARG[@]}" \
            /tmp/taskdef.json
```

**重要**：`deploy.yml` 里实际有**两个独立 job** 调用这三个工具，Step 4-5 目前只覆盖了第一个：

| Job | 位置 | 调用方式 |
|---|---|---|
| `deploy-service`（第 364 行起） | matrix，`matrix.service: [verification-svc, orchestrator-svc, query-svc]` | 三处调用在约 421/441/454 行，Step 4-5 已覆盖 |
| `deploy-web`（第 598 行起） | 非 matrix，固定 `--service web` | 三处调用在约 697/705/716 行，**本步骤新增处理** |

`deploy-web` job 结构上没有 `matrix`，`--service` 固定写死为 `web`，其余逻辑（三个工具的调用顺序、`--descriptor` 传法）与 `deploy-service` job 完全一致。

- [ ] **Step 5b：为 `deploy-web` job 新增契约提取步骤**

```bash
sed -n '598,620p' .github/workflows/deploy.yml
```

Expected: 看到 `deploy-web:` job 定义，`steps:` 下第一步是 `actions/checkout`，第二步是 `Configure AWS credentials`。

在 `actions/checkout` 步骤之后、`Configure AWS credentials` 步骤之前插入：

```yaml
      - name: Extract web's deployment contract from the bundle
        if: inputs.contract_bundle != ''
        env:
          CONTRACT_BUNDLE_B64: ${{ inputs.contract_bundle }}
        run: |
          set -euo pipefail
          echo "$CONTRACT_BUNDLE_B64" | base64 -d > /tmp/contract-bundle.json
          jq -e --arg env "${{ inputs.environment }}" \
            '.[$env]["web"] // error("no contract for " + $env + "/web in bundle")' \
            /tmp/contract-bundle.json > /tmp/contract.json
```

- [ ] **Step 5c：`deploy-web` job 内三处工具调用追加 `--contract`**

```bash
grep -n "node eng-tools/sync-secrets.mjs\|node eng-tools/render-taskdef.mjs\|node eng-tools/check-taskdef-boundary.mjs" .github/workflows/deploy.yml
```

Expected: 现在能看到六处调用（`deploy-service` job 三处 + `deploy-web` job 三处）。定位 `deploy-web` job 范围内（约 697-720 行）的三处，分别是：

`sync-secrets.mjs`（约 697 行）当前形如：
```yaml
          node eng-tools/sync-secrets.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service web \
            --descriptor @/tmp/ci-descriptor.json
```
改为：
```yaml
        run: |
          set -euo pipefail
          printf '%s' "$DESCRIPTOR" > /tmp/ci-descriptor.json
          CONTRACT_ARG=()
          if [ -f /tmp/contract.json ]; then CONTRACT_ARG=(--contract "@/tmp/contract.json"); fi
          node eng-tools/sync-secrets.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service web \
            --descriptor @/tmp/ci-descriptor.json \
            "${CONTRACT_ARG[@]}"
```

`render-taskdef.mjs`（约 705 行）当前形如：
```yaml
          node eng-tools/render-taskdef.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service web \
            --image "${{ steps.ecr-login.outputs.registry }}/${WEB_ECR_REPOSITORY}@${{ steps.build.outputs.digest }}" \
            --descriptor @/tmp/ci-descriptor.json \
            > /tmp/taskdef.json
```
改为：
```yaml
        run: |
          set -euo pipefail
          CONTRACT_ARG=()
          if [ -f /tmp/contract.json ]; then CONTRACT_ARG=(--contract "@/tmp/contract.json"); fi
          node eng-tools/render-taskdef.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service web \
            --image "${{ steps.ecr-login.outputs.registry }}/${WEB_ECR_REPOSITORY}@${{ steps.build.outputs.digest }}" \
            --descriptor @/tmp/ci-descriptor.json \
            "${CONTRACT_ARG[@]}" \
            > /tmp/taskdef.json
```

`check-taskdef-boundary.mjs`（约 716 行）当前形如：
```yaml
          node eng-tools/check-taskdef-boundary.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service web \
            /tmp/taskdef.json
```
改为：
```yaml
        run: |
          CONTRACT_ARG=()
          if [ -f /tmp/contract.json ]; then CONTRACT_ARG=(--contract "@/tmp/contract.json"); fi
          node eng-tools/check-taskdef-boundary.mjs \
            --env "${{ inputs.environment || 'dev' }}" \
            --service web \
            "${CONTRACT_ARG[@]}" \
            /tmp/taskdef.json
```

- [ ] **Step 6: YAML 语法验证**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy.yml'))" && echo "YAML OK"
```

- [ ] **Step 7: actionlint 验证（如果本地有 actionlint）**

```bash
which actionlint && actionlint .github/workflows/deploy.yml || echo "actionlint not installed locally, skipping (ops repo has it — cross-check there if needed)"
```

Expected: 无报错，或工具未安装的提示（不阻塞）。

- [ ] **Step 8: 提交**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat(deploy): accept and unpack a contract bundle from the caller

References: #SCV-217"
```

---

## Task 5：`deploy-builder.yml` 接收并解包 `contract_bundle`（dev + staging 两份）

**Files:**
- Modify: `.github/workflows/deploy-builder.yml`

- [ ] **Step 1: 新增 `contract_bundle` input**

在 `on: workflow_call: inputs: source_sha:` 定义之后、`secrets:` 块之前插入：

```yaml
      contract_bundle:
        description: >-
          Base64-encoded JSON, shaped `{ "<env>": { "builder": <contract> } }`, covering both dev and
          staging (this workflow registers both from one run). Optional: when empty, falls back to
          reading `config/deploy/<env>/builder.json` from this repository's own checkout.
        type: string
        required: false
        default: ""
```

- [ ] **Step 2: 验证 YAML 语法**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-builder.yml'))" && echo "YAML OK"
```

- [ ] **Step 3: 定位 `for ENV in dev staging` 循环并在循环前新增契约提取步骤**

```bash
grep -n "for ENV in dev staging\|actions/checkout\|check-taskdef-boundary" .github/workflows/deploy-builder.yml
```

Expected: 定位到 `actions/checkout` 步骤（job 开头）、两处 `for ENV in dev staging`（对应之前查明的两个 register 段）、以及 `check-taskdef-boundary.mjs` 调用行。

在 job 的 `actions/checkout` 步骤之后，新增一个独立步骤，一次性把两个环境的 contract 都解出来（不放在 `for ENV` 循环内部，因为这是一次性准备工作）：

```yaml
      - name: Extract builder's deployment contracts (dev + staging)
        if: inputs.contract_bundle != ''
        env:
          CONTRACT_BUNDLE_B64: ${{ inputs.contract_bundle }}
        run: |
          set -euo pipefail
          echo "$CONTRACT_BUNDLE_B64" | base64 -d > /tmp/contract-bundle.json
          for ENV in dev staging; do
            jq -e --arg env "$ENV" '.[$env]["builder"] // error("no contract for " + $env + "/builder in bundle")' \
              /tmp/contract-bundle.json > "/tmp/contract-${ENV}.json"
          done
```

- [ ] **Step 4: 在两处 `check-taskdef-boundary.mjs` 调用处追加 `--contract`**

```bash
grep -n "node eng-tools/check-taskdef-boundary.mjs" .github/workflows/deploy-builder.yml
```

Expected: 两处调用，形如：
```yaml
              node eng-tools/check-taskdef-boundary.mjs --env "$ENV" --service builder /tmp/builder-jobdef.json
```

各自改为（在同一个 `run:` 脚本块内，调用行之前加判断）：
```yaml
              CONTRACT_ARG=()
              if [ -f "/tmp/contract-${ENV}.json" ]; then CONTRACT_ARG=(--contract "@/tmp/contract-${ENV}.json"); fi
              node eng-tools/check-taskdef-boundary.mjs --env "$ENV" --service builder "${CONTRACT_ARG[@]}" /tmp/builder-jobdef.json
```

（这行在 `for ENV in dev staging; do ... done` 循环体内部，`$ENV` 在循环体内已绑定，直接可用。）

- [ ] **Step 5: YAML 语法验证**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-builder.yml'))" && echo "YAML OK"
```

- [ ] **Step 6: actionlint（如可用）**

```bash
which actionlint && actionlint .github/workflows/deploy-builder.yml || echo "actionlint not installed locally, skipping"
```

- [ ] **Step 7: 提交**

```bash
git add .github/workflows/deploy-builder.yml
git commit -m "feat(deploy-builder): accept and unpack a contract bundle from the caller

References: #SCV-217"
```

---

## Task 6：`deploy-composer.yml` 接收并解包 `contract_bundle`

**Files:**
- Modify: `.github/workflows/deploy-composer.yml`

- [ ] **Step 1: 新增 `contract_bundle` input**

在 `on: workflow_call: inputs: source_sha:` 定义之后、`secrets:` 块之前插入（与 Task 5 相同结构，描述文字改为 composer 语境）：

```yaml
      contract_bundle:
        description: >-
          Base64-encoded JSON, shaped `{ "<env>": { "composer": <contract> } }`, covering both dev and
          staging (this workflow's matrix runs both from one dispatch). Optional: when empty, falls
          back to reading `config/deploy/<env>/composer.json` from this repository's own checkout.
        type: string
        required: false
        default: ""
```

- [ ] **Step 2: YAML 语法验证**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-composer.yml'))" && echo "YAML OK"
```

- [ ] **Step 3: 定位 matrix job 并新增契约提取步骤**

```bash
grep -n "matrix:\|environment: \[dev, staging\]\|actions/checkout\|check-taskdef-boundary" .github/workflows/deploy-composer.yml
```

Expected: 找到 `strategy: / matrix: / environment: [dev, staging]` 所在 job，其 `steps:` 里的 `actions/checkout` 步骤位置，以及 `check-taskdef-boundary.mjs` 调用行（第 213 行附近，`--env "${{ matrix.environment }}" --service composer`）。

在该 job 的 `actions/checkout` 步骤之后新增：

```yaml
      - name: Extract composer's deployment contract from the bundle
        if: inputs.contract_bundle != ''
        env:
          CONTRACT_BUNDLE_B64: ${{ inputs.contract_bundle }}
        run: |
          set -euo pipefail
          echo "$CONTRACT_BUNDLE_B64" | base64 -d > /tmp/contract-bundle.json
          jq -e --arg env "${{ matrix.environment }}" \
            '.[$env]["composer"] // error("no contract for " + $env + "/composer in bundle")' \
            /tmp/contract-bundle.json > /tmp/contract.json
```

- [ ] **Step 4: `check-taskdef-boundary.mjs` 调用处追加 `--contract`**

将（第 213 行附近，实际以 grep 结果为准）：
```yaml
          node eng-tools/check-taskdef-boundary.mjs \
            --env "${{ matrix.environment }}" --service composer /tmp/composer-jobdef.json
```

改为（在同一个 `run:` 脚本块内，调用行之前加判断）：
```yaml
          CONTRACT_ARG=()
          if [ -f /tmp/contract.json ]; then CONTRACT_ARG=(--contract "@/tmp/contract.json"); fi
          node eng-tools/check-taskdef-boundary.mjs \
            --env "${{ matrix.environment }}" --service composer "${CONTRACT_ARG[@]}" /tmp/composer-jobdef.json
```

- [ ] **Step 5: YAML 语法验证**

```bash
python3 -c "import yaml; yaml.safe_load(open('.github/workflows/deploy-composer.yml'))" && echo "YAML OK"
```

- [ ] **Step 6: actionlint（如可用）**

```bash
which actionlint && actionlint .github/workflows/deploy-composer.yml || echo "actionlint not installed locally, skipping"
```

- [ ] **Step 7: 提交**

```bash
git add .github/workflows/deploy-composer.yml
git commit -m "feat(deploy-composer): accept and unpack a contract bundle from the caller

References: #SCV-217"
```

---

## Task 7：全量核查

**Files:** 无新文件改动，纯验证

- [ ] **Step 1: 全部 eng-tools 脚本语法检查**

```bash
find eng-tools -iname "*.mjs" | xargs -I{} node --check {} && echo "all eng-tools syntax OK"
```

Expected: `all eng-tools syntax OK`。

- [ ] **Step 2: 全部改动过的 workflow YAML 语法检查**

```bash
for f in .github/workflows/deploy.yml .github/workflows/deploy-builder.yml .github/workflows/deploy-composer.yml; do
  python3 -c "import yaml; yaml.safe_load(open('$f'))" && echo "$f: YAML OK"
done
```

Expected: 三行 `YAML OK`。

- [ ] **Step 3: 确认三个工具都有 --contract 分支**

```bash
grep -l "flag(\"contract\")" eng-tools/sync-secrets.mjs eng-tools/render-taskdef.mjs eng-tools/check-taskdef-boundary.mjs
```

Expected: 三个文件路径全部列出。

- [ ] **Step 3b: 确认 deploy.yml 里六处工具调用（两个 job × 三个工具）都追加了 --contract**

```bash
grep -c 'CONTRACT_ARG=()' .github/workflows/deploy.yml
```

Expected: `6`（`deploy-service` job 三处 + `deploy-web` job 三处）。

- [ ] **Step 4: 确认三个 workflow 都有 contract_bundle input**

```bash
grep -l "contract_bundle" .github/workflows/deploy.yml .github/workflows/deploy-builder.yml .github/workflows/deploy-composer.yml
```

Expected: 三个文件路径全部列出。

- [ ] **Step 5: 查看完整 diff 做最终人工确认**

```bash
git diff main --stat
```

Expected: 6 个文件改动（3 个 `.mjs` + 3 个 `.yml`）。

```bash
git log main..HEAD --oneline
```

Expected: 6 条 commit，对应 Task 1-6。

- [ ] **Step 6: 推送分支并开 PR（需用户确认后执行，不要自动 push）**

```bash
git push -u origin fix/scv-217-contract-injection-tools
```

```bash
gh pr create --title "feat(deploy): support explicit contract injection for SCV-217" --body "$(cat <<'EOF'
## Summary
- 三个部署工具（sync-secrets.mjs、render-taskdef.mjs、check-taskdef-boundary.mjs）新增 `--contract @<file>` 参数，语法与既有的 `--descriptor` 一致，优先于 `process.cwd()` 拼路径读取
- 三个 reusable workflow（deploy.yml、deploy-builder.yml、deploy-composer.yml）新增可选 `contract_bundle` input（base64 JSON，`{env: {service: contract}}` 两层结构），解包后写临时文件并通过 `--contract` 传给工具

## 背景
SCV-217 描述的问题：这三个工具历来通过 `process.cwd()` 拼路径读取 `config/deploy/<env>/<service>.json`，但 reusable workflow 运行时 checkout 的一直是本仓库自己（cwd 是本仓库树），从未有任何机制让 caller（`soroban-verification-ops`）的契约文件进入这个执行上下文——导致所有跨仓库调用必然在这一步失败。

本 PR 是"能接收"的一半；"实际发送"的一半在 `soroban-verification-ops` 仓库单独提交，依赖本 PR 先合并才有意义（新参数存在了，ops 侧才有东西可以传）。

## 向后兼容
`--contract`/`contract_bundle` 都是全新可选参数，不传时完全退回现状（`process.cwd()` 读取），本 PR 合并后不会改变任何现有调用方的行为。

## Test plan
- [x] `node --check` 全部通过
- [x] 每个工具用最小构造场景手工验证 `--contract` 确实生效（读取的是显式传入内容而非 cwd 文件）
- [x] 三个 workflow YAML 语法（`yaml.safe_load`）通过
- [ ] 待 ops 侧对应 PR 合并后，端到端联调验证

References: #SCV-217
EOF
)"
```

---

## Self-Review 记录

- **Spec 覆盖检查**：spec 文档"service 侧消费方式"章节对 `deploy.yml`/`deploy-composer.yml`/`deploy-builder.yml` 三种不同结构（matrix service / matrix environment / shell 循环两环境）分别给出的代码片段，均已对应到 Task 4/6/5。工具接口 `--contract @<file>` 对应 Task 1-3。
- **占位符扫描**：所有步骤都是具体代码和具体验证命令，无 TBD。Task 4 Step 5 里对"两处 sync-secrets.mjs 调用是否属于同一 job"标注了需要执行时核实并如实记录的开放问题——这不是占位符，是明确指出了一个需要在执行时用命令验证、而非在计划撰写时假设的分支，并给出了两种情况各自的处理方式。
- **类型/接口一致性**：`--contract @<file>` 语法在三个工具、三个 workflow 中保持完全一致；打包 key 结构（`env` → `service`）与 ops 侧 spec 约定一致。
