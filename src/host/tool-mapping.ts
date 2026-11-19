import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import {
  experimental_fileReadPresentation as nativeFileReadPresentation,
  experimental_planStepsPresentation as planStepsPresentation,
  experimental_presentationTitle as presentationTitle,
  experimental_searchPresentation as searchPresentation,
  experimental_toolPresentation as toolPresentation,
  experimental_webFetchPresentation as webFetchPresentation,
  experimental_webSearchPresentation as webSearchPresentation,
  type DynamicTool,
} from "@get-bb/plugin-sdk/provider-bridge";
import {
  firstInputString,
  inputRecord,
  isSubagentTool,
  stringValue,
  type OpenCodeRecord,
} from "./types.ts";

type RecordValue = OpenCodeRecord;

const execFileAsync = promisify(execFile);
const MAX_TOUCHED_PATHS = 16;

export async function gitDiff(cwd: string, file: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["diff", "--no-ext-diff", "--", file],
      {
        cwd,
        timeout: 2_000,
        encoding: "utf8",
        maxBuffer: 256 * 1024,
      },
    );
    return stdout.length > 32_000 ? `${stdout.slice(0, 32_000)}…` : stdout;
  } catch {
    return "";
  }
}

/** Full-content diff for a file git does not track yet. */
export async function gitDiffNewFile(
  cwd: string,
  file: string,
): Promise<string> {
  try {
    await execFileAsync(
      "git",
      ["diff", "--no-ext-diff", "--no-index", "--", "/dev/null", file],
      { cwd, timeout: 2_000, encoding: "utf8", maxBuffer: 256 * 1024 },
    );
    return "";
  } catch (error) {
    // `git diff --no-index` exits 1 when the files differ.
    const stdout = (error as { stdout?: unknown }).stdout;
    if (typeof stdout !== "string") return "";
    return stdout.length > 32_000 ? `${stdout.slice(0, 32_000)}…` : stdout;
  }
}

function realpathOr(path: string) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Workspace-relative path for a file OpenCode touched. OpenCode resolves
 * symlinks (for example /tmp -> /private/tmp on macOS) and reports paths
 * relative to the unresolved cwd, so compare real paths on both sides.
 */
export function workspacePath(cwd: string, file: string): string {
  const absolute = resolve(cwd, file);
  for (const base of [cwd, realpathOr(cwd)]) {
    const rel = relative(base, absolute);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) return rel;
  }
  const real = realpathOr(absolute);
  const rel = relative(realpathOr(cwd), real);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : absolute;
}

/**
 * OpenCode v2 edit tools report each file they touched with a unified patch:
 * `metadata.files: [{file, patch, status: added|modified|deleted}]`.
 */
export function metadataFileChanges(metadata: unknown, cwd: string) {
  const files = inputRecord(metadata).files;
  if (!Array.isArray(files)) return [];
  return files.flatMap((value: unknown) => {
    const entry = inputRecord(value);
    const file = stringValue(entry.file);
    if (!file) return [];
    const path = workspacePath(cwd, file);
    const kind =
      entry.status === "added"
        ? "add"
        : entry.status === "deleted"
          ? "delete"
          : "update";
    // Patch headers repeat OpenCode's own spelling of the path, which can
    // climb out through a symlinked cwd; show the workspace path instead.
    const raw = stringValue(entry.patch);
    const patch = raw && path !== file ? raw.split(file).join(path) : raw;
    return [{ path, kind, ...(patch ? { diff: patch } : {}) }];
  });
}

export function contentText(value: unknown) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return "";
  return value
    .map((part: unknown) => {
      if (typeof part === "string") return part;
      return stringValue(inputRecord(part).text) ?? "";
    })
    .join("\n");
}

function isDirectory(path: string, cwd: string) {
  try {
    return statSync(resolve(cwd, path)).isDirectory();
  } catch {
    return false;
  }
}

function directoryRow(path: string) {
  return {
    item: { type: "search", mode: "list", query: path },
    presentation: {
      icon: { glyph: "FolderOpen" },
      label: { pending: "Listing files", completed: "Listed files" },
      title: path,
    },
  };
}

function fileReadRow(path: string) {
  return {
    item: { type: "fileRead", path },
    // BB's native file row supplies the path title itself. Keep the action
    // label as "Read", matching Pi, instead of "Read file".
    presentation: {
      ...nativeFileReadPresentation(path),
      label: { pending: "Reading", completed: "Read" },
    },
  };
}

function todoSteps(input: RecordValue) {
  const todos = Array.isArray(input.todos)
    ? input.todos
    : Array.isArray(input.items)
      ? input.items
      : undefined;
  if (!todos) return undefined;
  const steps = todos
    .map((value: unknown) => {
      const todo = inputRecord(value);
      const step = stringValue(todo.content ?? todo.text ?? todo.title);
      if (!step) return undefined;
      const status =
        todo.status === "completed" || todo.status === "done"
          ? ("completed" as const)
          : ("pending" as const);
      return { step, status };
    })
    .filter(
      (step): step is { step: string; status: "completed" | "pending" } =>
        step !== undefined,
    );
  return steps.length ? steps : undefined;
}

function patchPaths(input: RecordValue) {
  const patchText = stringValue(input.patchText ?? input.patch ?? input.diff);
  if (!patchText) return undefined;
  const out: string[] = [];
  for (const match of patchText.matchAll(
    /^\*\*\*\s+(?:Add File|Update File|Move to|Delete File|Rename to):\s*(.+?)\s*$/gm,
  )) {
    const file = match[1].trim();
    if (file) out.push(file);
  }
  return out.length ? [...new Set(out)].slice(0, MAX_TOUCHED_PATHS) : undefined;
}

function patchTitle(input: RecordValue) {
  return presentationTitle(
    patchPaths(input)?.[0] ??
      stringValue(input.patchText ?? input.patch ?? input.diff) ??
      "",
  );
}

export function touchedPaths(name: string, rawInput: unknown): string[] {
  const tool = name.toLowerCase();
  const input = inputRecord(rawInput);
  if (["write", "edit", "multiedit"].includes(tool)) {
    const path = firstInputString(input, [
      "filePath",
      "file_path",
      "path",
      "filename",
      "file",
    ]);
    return path ? [path] : [];
  }
  if (["apply_patch", "patch"].includes(tool)) {
    return (
      patchPaths(input) ??
      (() => {
        const path = firstInputString(input, [
          "filePath",
          "file_path",
          "path",
          "filename",
          "file",
        ]);
        return path ? [path] : [];
      })()
    );
  }
  return [];
}

/**
 * OpenCode names MCP tools `<server>_<tool>`. Calls to the per-session BB
 * tool server render as the BB tool, with the presentation BB supplied.
 */
export function dynamicToolRow(
  serverName: string,
  tools: readonly DynamicTool[],
  name: string,
  rawInput: unknown,
) {
  const prefix = `${serverName}_`;
  if (!name.startsWith(prefix)) return undefined;
  const toolName = name.slice(prefix.length);
  const tool = tools.find((candidate) => candidate.name === toolName);
  const input = inputRecord(rawInput);
  const fallbackTitle = presentationTitle(
    Object.values(input).find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    ) ?? "",
  );
  return {
    item: { type: "tool", tool: toolName, args: input },
    presentation: tool?.presentation ?? {
      ...toolPresentation(toolName),
      ...(fallbackTitle ? { title: fallbackTitle } : {}),
    },
  };
}

export function toolRow(name: string, rawInput: unknown, cwd: string) {
  const input = inputRecord(rawInput);
  const tool = name.toLowerCase();
  const path = firstInputString(input, [
    "filePath",
    "file_path",
    "path",
    "filename",
    "file",
  ]);

  if (["read", "read_file", "cat"].includes(tool) && path) {
    if (isDirectory(path, cwd)) return directoryRow(path);
    return fileReadRow(path);
  }

  if (["grep", "search", "codesearch", "code_search"].includes(tool)) {
    const query =
      firstInputString(input, ["pattern", "query", "search", "text"]) ?? "";
    return {
      item: {
        type: "search",
        mode: "content",
        query,
        ...(path ? { path } : {}),
      },
      presentation: searchPresentation({ mode: "content", query }),
    };
  }

  if (["glob", "find", "find_files"].includes(tool)) {
    const query =
      firstInputString(input, ["pattern", "filePattern", "query"]) ??
      path ??
      "";
    return {
      item: { type: "search", mode: "path", query },
      presentation: searchPresentation({ mode: "path", query }),
    };
  }

  if (["list", "ls", "list_directory", "list_files"].includes(tool)) {
    const query = path ?? ".";
    return {
      item: { type: "search", mode: "list", query },
      presentation: {
        icon: { glyph: "FolderOpen" },
        label: { pending: "Listing files", completed: "Listed files" },
        ...(presentationTitle(query)
          ? { title: presentationTitle(query) }
          : {}),
      },
    };
  }

  if (["bash", "shell", "exec", "run", "command"].includes(tool)) {
    const command = firstInputString(input, ["command", "cmd", "script"]) ?? "";
    return {
      item: {
        type: "command",
        command,
        cwd: firstInputString(input, ["workdir", "cwd"]) ?? cwd,
      },
      presentation: {
        icon: { glyph: "Terminal" },
        label: { pending: "Running command", completed: "Ran command" },
        ...(presentationTitle(command)
          ? { title: presentationTitle(command) }
          : {}),
      },
    };
  }

  if (["websearch", "web_search", "search_web"].includes(tool)) {
    const query = firstInputString(input, ["query", "search", "q"]);
    return {
      item: { type: "webSearch", queries: query ? [query] : [] },
      presentation: webSearchPresentation(query),
    };
  }

  if (["webfetch", "web_fetch", "fetch", "read_web_page"].includes(tool)) {
    const url = firstInputString(input, ["url", "uri"]);
    if (url)
      return {
        item: { type: "webFetch", url, pattern: null },
        presentation: webFetchPresentation(url),
      };
  }

  if (["write", "edit", "apply_patch", "patch", "multiedit"].includes(tool)) {
    const title =
      tool === "apply_patch" || tool === "patch"
        ? (patchTitle(input) ?? (path ? presentationTitle(path) : undefined))
        : path
          ? presentationTitle(path)
          : undefined;
    return {
      item: { type: "tool", tool: name, args: input },
      presentation: {
        icon: { glyph: "Toolbox" },
        label: { pending: `Writing file`, completed: `Wrote file` },
        suppress: true,
        ...(title ? { title } : {}),
      },
    };
  }

  if (isSubagentTool(name)) {
    // Rendered as BB's native delegation row. The router fills in the child
    // session once OpenCode reports it; until then the call ID stands in.
    // Subagents always run in the background since OpenCode 2.3, so the row
    // is thread-scoped and can settle after the turn that spawned it.
    const agent = firstInputString(input, ["agent", "subagent_type"]);
    const description = firstInputString(input, [
      "description",
      "prompt",
      "task",
    ]);
    return {
      item: {
        type: "delegation",
        childRef: "pending",
        label:
          [agent, description].filter(Boolean).join(": ") ||
          "OpenCode subagent",
        background: true,
      },
    };
  }

  if (tool === "skill") {
    const title = presentationTitle(
      firstInputString(input, ["name", "skill", "id"]) ?? "",
    );
    return {
      item: { type: "tool", tool: name, args: input },
      presentation: {
        icon: { glyph: "Toolbox" },
        label: { pending: "Loading skill", completed: "Loaded skill" },
        ...(title ? { title } : {}),
      },
    };
  }

  if (tool === "todowrite" || tool === "todoread") {
    const steps = todoSteps(input);
    if (steps) {
      return {
        item: { type: "planSteps", steps },
        presentation: planStepsPresentation(
          steps.map((step) => ({
            ...step,
            status:
              step.status === "completed"
                ? ("completed" as const)
                : ("active" as const),
          })),
        ),
      };
    }
    const title = presentationTitle(
      firstInputString(input, ["content", "text", "title"]) ?? "",
    );
    return {
      item: { type: "tool", tool: name, args: input },
      presentation: {
        icon: { glyph: "Toolbox" },
        label: { pending: "Updating tasks", completed: "Updated tasks" },
        ...(title ? { title } : {}),
      },
    };
  }

  if (tool === "question") {
    const questions = Array.isArray(input.questions)
      ? input.questions
      : undefined;
    const first = questions
      ?.map((value: unknown) => {
        const question = inputRecord(value);
        return stringValue(question.question ?? question.text);
      })
      .find(Boolean);
    const title = presentationTitle(
      first ?? firstInputString(input, ["question", "text", "prompt"]) ?? "",
    );
    return {
      item: { type: "tool", tool: name, args: input },
      presentation: {
        icon: { glyph: "Toolbox" },
        label: { pending: "Asking question", completed: "Asked question" },
        ...(title ? { title } : {}),
      },
    };
  }

  // OpenCode Code Mode: the model runs code against `tools.<server>.<tool>`.
  // The title names the tools it calls. Those calls are not separate rows:
  // BB renders any nested item as a subagent's work.
  if (tool === "execute" && typeof input.code === "string") {
    const calls = [
      ...new Set(
        [...input.code.matchAll(/tools\.([\w$]+)\.([\w$]+)/g)].map(
          (match) => `${match[1]}.${match[2]}`,
        ),
      ),
    ];
    const title = presentationTitle(calls.join(", "));
    return {
      item: { type: "tool", tool: name, args: input },
      presentation: {
        icon: { glyph: "Code" },
        label: { pending: "Running code", completed: "Ran code" },
        ...(title ? { title } : {}),
      },
    };
  }

  if (tool === "lsp") {
    const title = presentationTitle(
      [
        firstInputString(input, ["operation", "method", "command"]),
        path ?? firstInputString(input, ["file", "uri"]),
      ]
        .filter(Boolean)
        .join(" "),
    );
    return {
      item: { type: "tool", tool: name, args: input },
      presentation: {
        icon: { glyph: "Toolbox" },
        label: { pending: "Querying code", completed: "Queried code" },
        ...(title ? { title } : {}),
      },
    };
  }

  if (tool === "codesearch") {
    const query =
      firstInputString(input, ["query", "pattern", "search", "text"]) ?? "";
    return {
      item: {
        type: "search",
        mode: "content",
        query,
        ...(path ? { path } : {}),
      },
      presentation: searchPresentation({ mode: "content", query }),
    };
  }

  const fallbackTitle = presentationTitle(
    firstInputString(input, [
      "description",
      "command",
      "query",
      "pattern",
      "url",
      "prompt",
      "text",
      "title",
      "name",
    ]) ??
      path ??
      Object.values(input).find(
        (v): v is string => typeof v === "string" && v.trim().length > 0,
      ) ??
      "",
  );
  return {
    item: { type: "tool", tool: name, args: input },
    presentation: {
      ...toolPresentation(name),
      ...(fallbackTitle ? { title: fallbackTitle } : {}),
    },
  };
}
