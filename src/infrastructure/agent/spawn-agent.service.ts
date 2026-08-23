import { spawn } from 'node:child_process';
import type { IAgentRunner, AgentRunResult } from '../../domain/interfaces/agent-runner.interface.js';
import { config } from '../../config/index.js';
import { logger } from '../logging/logger.js';

/**
 * Spawns `claude --agent <name>` headless in the given workspace directory.
 *
 * Unlike the old caf-orchestrator runners (fast request/response API calls),
 * a Claude Code agent run can take minutes to tens of minutes. Timeout
 * enforcement lives here (CLAUDE_AGENT_TIMEOUT_MS) rather than relying on
 * BullMQ's job timeout/lock — see risk #1 in caf-orchestrator-plan.md.
 *
 * If the process dies mid-run (killed by signal, OOM, etc.) rather than
 * exiting with a normal/non-zero code, that's surfaced via `signal` in the
 * result so callers can distinguish "agent finished and failed" from
 * "agent process was killed". v1 policy is full-retry on either case — no
 * step-resume state is written (risk #2).
 */
export class SpawnAgentService implements IAgentRunner {
  async run(agentName: string, cwd: string, prompt: string): Promise<AgentRunResult> {
    return new Promise((resolve) => {
      logger.info('Spawning agent', undefined, { agentName, cwd });

      // Headless (--print) runs can't answer interactive permission prompts, so
      // tool calls (Write, etc.) would otherwise be silently denied and the
      // agent would exit 0 having done nothing. Each run happens in a fresh,
      // disposable clone workspace, so bypassing the prompt is safe here.
      // Opt-in OpenRouter routing: only inject Anthropic-endpoint overrides
      // when explicitly enabled, so process.env is passed through unchanged
      // by default (see CLAUDE.md — do not rebuild env from scratch here,
      // the child process needs PATH and other inherited vars).
      const openaiEnv = config.openai.useOpenai
        ? {
            ...process.env,
            ANTHROPIC_BASE_URL: config.openai.baseUrl,
            // The claude CLI reads ANTHROPIC_API_KEY (not ANTHROPIC_AUTH_TOKEN) when
            // calling an Anthropic-compatible endpoint via ANTHROPIC_BASE_URL.
            // Previously this was set to an empty string, causing Claude to fall
            // through to OAuth / keychain auth instead of using the OpenRouter key.
            ANTHROPIC_API_KEY: config.OPENAI_API_KEY ?? '',
            ...(config.openai.defaultModel
              ? {
                  // Remap both the "sonnet" and "haiku" model aliases to the
                  // configured model. Without ANTHROPIC_DEFAULT_HAIKU_MODEL, any
                  // agent definition that specifies a haiku model (e.g.
                  // claude-haiku-4-5-20251001) will be sent as-is to the custom
                  // endpoint where it likely doesn't exist, producing a 404 error.
                  ANTHROPIC_DEFAULT_SONNET_MODEL: config.openai.defaultModel,
                  ANTHROPIC_DEFAULT_HAIKU_MODEL: config.openai.defaultModel,
                }
              : {}),
          }
        : process.env;

      // Per-agent model override (agents.modelOverrides in caf.config.yaml, e.g.
      // { qa: "claude-haiku-4-5-20251001" }) takes precedence over the global
      // openai.defaultModel above, and applies independent of openai.useOpenai —
      // ANTHROPIC_DEFAULT_SONNET_MODEL/HAIKU_MODEL are honored by the claude CLI
      // against the native Anthropic API too, not just through a custom
      // ANTHROPIC_BASE_URL.
      const agentModel = config.agents.modelOverrides[agentName];
      const env = {
        ...(agentModel
          ? {
              ...openaiEnv,
              ANTHROPIC_DEFAULT_SONNET_MODEL: agentModel,
              ANTHROPIC_DEFAULT_HAIKU_MODEL: agentModel,
            }
          : openaiEnv),
        // Every caller of this service runs headless (see run-agent-pipeline
        // use-case) — set unconditionally rather than gated on config, since
        // this is the single spawn choke point for all agents.
        CAF_HEADLESS: '1',
      };

      const proc = spawn(
        config.claude.command,
        [
          '--agent', agentName,
          '--print',
          '--output-format', 'json',
          '--permission-mode', 'bypassPermissions',
        ],
        {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env,
        },
      );

      // Agents may lack a Bash tool (e.g. planner), so they can't read
      // CAF_HEADLESS from process.env directly — prepend the same signal as
      // prompt text so every agent definition sees it regardless of tools.
      const headlessPrompt = [
        '[SYSTEM CONTEXT: Environment = headless. No interactive user available. Do NOT stop and wait for chat confirmation under any circumstance.]',
        '',
        '',
        prompt,
      ].join('\n');

      proc.stdin.write(headlessPrompt);
      proc.stdin.end();

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let timedOut = false;

      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        logger.warn('Agent run exceeded timeout, killing process', undefined, {
          agentName,
          timeoutMs: config.claude.agentTimeoutMs,
        });
        proc.kill('SIGTERM');
        // Escalate if it doesn't die quickly.
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 10_000);
      }, config.claude.agentTimeoutMs);

      proc.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      proc.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

      proc.on('close', (code, signal) => {
        clearTimeout(timeoutHandle);

        const result: AgentRunResult = {
          exitCode: code,
          signal,
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: Buffer.concat(stderr).toString('utf-8'),
          timedOut,
        };

        if (signal) {
          logger.error(
            'Agent process terminated by signal',
            new Error(`Agent ${agentName} killed by ${signal}`),
            { agentName, signal, timedOut },
          );
        } else {
          logger.info('Agent run finished', undefined, { agentName, exitCode: code });
        }

        resolve(result);
      });

      proc.on('error', (spawnErr) => {
        clearTimeout(timeoutHandle);
        logger.error('Agent spawn error', spawnErr, { agentName });
        resolve({
          exitCode: null,
          signal: null,
          stdout: Buffer.concat(stdout).toString('utf-8'),
          stderr: spawnErr.message,
          timedOut: false,
        });
      });
    });
  }
}

export const spawnAgentService = new SpawnAgentService();
