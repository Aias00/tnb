import { describe, expect, test } from "bun:test";

import { analyzeShellCommand, resolveShellInvocation } from "../../src/core/shell-permissions";

describe("shell permissions", () => {
  test("classifies read-only POSIX commands and pipelines", () => {
    const analysis = analyzeShellCommand("pwd && git status | head", {
      family: "posix",
      cwd: "/workspace/project",
    });

    expect(analysis.isReadOnly).toBe(true);
    expect(analysis.isSafeAutoApproved).toBe(false);
    expect(analysis.segments.map((segment) => segment.executable)).toEqual([
      "pwd",
      "git",
      "head",
    ]);
  });

  test("rejects write-like shell operators and redirection from read-only classification", () => {
    expect(
      analyzeShellCommand("cat notes.txt > copy.txt", {
        family: "posix",
        cwd: "/workspace/project",
      }),
    ).toMatchObject({
      hasRedirection: true,
      isReadOnly: false,
      isSafeAutoApproved: false,
    });

    expect(
      analyzeShellCommand("ls &", {
        family: "posix",
        cwd: "/workspace/project",
      }),
    ).toMatchObject({
      hasBackgrounding: true,
      isReadOnly: false,
      isSafeAutoApproved: false,
    });

    expect(
      analyzeShellCommand("echo $(whoami)", {
        family: "posix",
        cwd: "/workspace/project",
      }),
    ).toMatchObject({
      hasCommandSubstitution: true,
      isReadOnly: false,
      isSafeAutoApproved: false,
    });
  });

  test("auto-approves a constrained workspace-safe copy or move command", () => {
    expect(
      analyzeShellCommand("mkdir -p src/tmp && touch src/tmp/file.txt", {
        family: "posix",
        cwd: "/workspace/project",
      }).isSafeAutoApproved,
    ).toBe(true);

    expect(
      analyzeShellCommand("cp src/a.txt ../escape.txt", {
        family: "posix",
        cwd: "/workspace/project",
      }).isSafeAutoApproved,
    ).toBe(false);
  });

  test("understands PowerShell aliases and default shell selection on Windows", () => {
    const invocation = resolveShellInvocation({}, "win32");
    expect(invocation.family).toBe("powershell");
    expect(invocation.file).toBe("powershell.exe");
    expect(invocation.args("Get-ChildItem")).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-Command",
      "Get-ChildItem",
    ]);

    const readOnly = analyzeShellCommand("dir src | select Name", {
      family: "powershell",
      cwd: "C:/workspace/project",
    });
    expect(readOnly.isReadOnly).toBe(true);

    const write = analyzeShellCommand("New-Item -Path src/tmp -ItemType Directory", {
      family: "powershell",
      cwd: "C:/workspace/project",
    });
    expect(write.isReadOnly).toBe(false);
  });

  test("prefers configured PowerShell binary and preserves configured POSIX shell", () => {
    expect(resolveShellInvocation({ TNB_POWERSHELL: "pwsh.exe" }, "win32").file).toBe("pwsh.exe");
    expect(resolveShellInvocation({ TNB_SHELL: "/bin/bash" }, "darwin")).toMatchObject({
      family: "posix",
      file: "/bin/bash",
    });
    expect(resolveShellInvocation({ TNB_SHELL: "C:/Program Files/PowerShell/7/pwsh.exe" }, "win32")).toMatchObject({
      family: "powershell",
      file: "C:/Program Files/PowerShell/7/pwsh.exe",
    });
  });

  test("fails closed on nested shell execution wrappers", () => {
    expect(
      analyzeShellCommand("sh -c 'pwd'", {
        family: "posix",
        cwd: "/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });

    expect(
      analyzeShellCommand("pwsh -NoProfile -Command Get-ChildItem", {
        family: "powershell",
        cwd: "C:/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });
  });

  test("fails closed on PowerShell encoded commands and dynamic execution", () => {
    expect(
      analyzeShellCommand("pwsh -NoProfile -EncodedCommand RwBlAHQALQBDAGgAaQBsAGQASQB0AGUAbQA=", {
        family: "powershell",
        cwd: "C:/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });

    expect(
      analyzeShellCommand("Invoke-Expression 'Get-ChildItem'", {
        family: "powershell",
        cwd: "C:/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });

    expect(
      analyzeShellCommand("iex 'Get-ChildItem'", {
        family: "powershell",
        cwd: "C:/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });
  });

  test("fails closed on PowerShell splatting and unicode separators", () => {
    expect(
      analyzeShellCommand("Get-ChildItem @args", {
        family: "powershell",
        cwd: "C:/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });

    expect(
      analyzeShellCommand("Get-ChildItem\u00A0src", {
        family: "powershell",
        cwd: "C:/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });
  });

  test("fails closed on incomplete shell structures", () => {
    expect(
      analyzeShellCommand("echo ${PWD", {
        family: "posix",
        cwd: "/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });

    expect(
      analyzeShellCommand("Get-ChildItem @{ Path = 'src' ", {
        family: "powershell",
        cwd: "C:/workspace/project",
      }),
    ).toMatchObject({
      isReadOnly: false,
      isSafeAutoApproved: false,
    });
  });

  test("fails closed on upstream parser differential and expansion cases", () => {
    const cases = [
      "cat\u00a0/etc/passwd",
      "cat\\ /etc/passwd",
      "=cat /etc/passwd",
      "echo $((1#$(id)))",
      "cat <<EOF\n$(id)\nEOF",
      'command "do :"',
      "coproc cat /etc/passwd",
    ];

    for (const command of cases) {
      const analysis = analyzeShellCommand(command, { cwd: "/workspace", family: "posix" });
      expect(analysis.isReadOnly).toBe(false);
      expect(analysis.isSafeAutoApproved).toBe(false);
    }
  });

  test("analyzes command and env wrappers instead of trusting the wrapper", () => {
    expect(analyzeShellCommand("command git status", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("command rm notes.txt", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("env LANG=C rg needle src", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("env MODE=clean sh -c 'rm -rf build'", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("LC_ALL=C git status", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("MODE=clean rm notes.txt", { family: "posix" }).isReadOnly).toBe(false);
  });

  test("rejects mutating find and sed actions", () => {
    expect(analyzeShellCommand("find src -type f -print", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("find src -type f -exec rm {} +", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("find src -type f -exec stat {} +", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("find src -name '*.tmp' -delete", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("sed -n '1,20p' file.txt", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("sed -i '' 's/a/b/' file.txt", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("sed -e 'w output.txt' file.txt", { family: "posix" }).isReadOnly).toBe(false);
  });

  test("recursively classifies xargs and rejects Git output-file side effects", () => {
    expect(analyzeShellCommand("printf '%s\\n' src | xargs -n 1 stat", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("printf '%s\\n' build | xargs rm -rf", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("git diff --output=changes.patch", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("git log --output history.txt", { family: "posix" }).isReadOnly).toBe(false);
  });

  test("distinguishes read-only Git inspection from branch, tag, and remote mutation", () => {
    expect(analyzeShellCommand("git -C repo status", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("git branch --list feature/*", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("git branch feature/new", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("git tag --list 'v*'", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("git tag v2", { family: "posix" }).isReadOnly).toBe(false);
    expect(analyzeShellCommand("git remote -v", { family: "posix" }).isReadOnly).toBe(true);
    expect(analyzeShellCommand("git remote set-url origin example", { family: "posix" }).isReadOnly).toBe(false);
  });
});
