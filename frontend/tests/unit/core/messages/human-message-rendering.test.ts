import { describe, expect, it } from "vitest";

import { shouldRenderHumanMessageAsPlainText } from "@/core/messages/human-message-rendering";

describe("shouldRenderHumanMessageAsPlainText", () => {
  it("detects a pasted C source file without fenced code markers", () => {
    const source = `#include <stdio.h>
#include <unistd.h>

static int start_daemon_async(pid_t app_pid) {
    pid_t pid = fork();
    if (pid < 0) {
        perror("fork failed");
        return -1;
    }
    if (pid == 0) {
        start_daemon(app_pid);
    }
    return (int)pid;
}`;

    expect(shouldRenderHumanMessageAsPlainText(source)).toBe(true);
  });

  it("detects indented Python source pasted as plain text", () => {
    const source = `def collect_status(items):
    results = []
    for item in items:
        if item.enabled:
            results.append({
                "name": item.name,
                "status": item.status,
            })
    return results`;

    expect(shouldRenderHumanMessageAsPlainText(source)).toBe(true);
  });

  it("keeps explicitly fenced code in markdown mode", () => {
    const markdown = `Please review this:

\`\`\`c
int main(void) {
    return 0;
}
\`\`\``;

    expect(shouldRenderHumanMessageAsPlainText(markdown)).toBe(false);
  });

  it("keeps ordinary markdown lists in markdown mode", () => {
    const markdown = `请帮我整理这些点：

- 第一个问题是配置项不清楚
- 第二个问题是 flash 模式失败
- 第三个问题是需要补充测试

我希望最后输出一个 issue 回复。`;

    expect(shouldRenderHumanMessageAsPlainText(markdown)).toBe(false);
  });

  it("keeps long prose in markdown mode", () => {
    const prose = `这是一段比较长的中文说明，用来模拟用户正常描述问题的情况。
它可能有很多行，也可能包含一些英文单词，例如 flash mode 或 reasoning_effort。
但是它不是源码，也没有大量缩进、分号、括号、函数声明或控制流。
这种内容应该继续交给 Markdown 渲染，以便链接、列表和普通排版仍然正常。
如果把它误判成纯文本代码块，用户消息会显得过于沉重。
所以这里需要保持保守。`;

    expect(shouldRenderHumanMessageAsPlainText(prose)).toBe(false);
  });

  it("does not treat a short inline code question as a pasted source file", () => {
    const message = `为什么 \`exit(EXIT_FAILURE)\` 会导致进程退出？
我只想问这个函数的行为，不是在粘贴完整代码。`;

    expect(shouldRenderHumanMessageAsPlainText(message)).toBe(false);
  });
});
