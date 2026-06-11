import { expect, test, type Route } from "@playwright/test";

import {
  handleRunStream,
  MOCK_RUN_ID,
  MOCK_THREAD_ID,
  mockLangGraphAPI,
} from "./utils/mock-api";

function handleRunStreamWithHumanContent(route: Route, humanContent: string) {
  const events = [
    {
      event: "metadata",
      data: { run_id: MOCK_RUN_ID, thread_id: MOCK_THREAD_ID },
    },
    {
      event: "values",
      data: {
        messages: [
          {
            type: "human",
            id: "msg-human-plain-text",
            content: [{ type: "text", text: humanContent }],
          },
          {
            type: "ai",
            id: "msg-ai-plain-text",
            content: "Hello from DeerFlow!",
          },
        ],
      },
    },
    { event: "end", data: {} },
  ];

  return route.fulfill({
    status: 200,
    contentType: "text/event-stream",
    body: events
      .map((e) => `event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`)
      .join(""),
  });
}

test.describe("Chat workspace", () => {
  test.beforeEach(async ({ page }) => {
    mockLangGraphAPI(page);
  });

  test("new chat page loads with input box", async ({ page }) => {
    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("button", { name: /load more/i })).toBeHidden();
  });

  test("can type a message in the input box", async ({ page }) => {
    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("Hello, DeerFlow!");
    await expect(textarea).toHaveValue("Hello, DeerFlow!");
  });

  test("suggests matching skills after a leading slash", async ({ page }) => {
    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("/dat");
    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeVisible();
    await expect(
      page.getByRole("option", { name: /disabled-skill/i }),
    ).toBeHidden();

    await textarea.press("Enter");

    await expect(textarea).toHaveValue("/data-analysis ");
  });

  test("keeps Shift+Enter as newline while skill suggestions are visible", async ({
    page,
  }) => {
    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("/dat");
    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeVisible();

    await textarea.press("Shift+Enter");

    await expect(textarea).toHaveValue("/dat\n");
    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeHidden();
  });

  test("does not suggest skills for slash text away from the prompt start", async ({
    page,
  }) => {
    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("please /dat");

    await expect(
      page.getByRole("option", { name: /data-analysis/i }),
    ).toBeHidden();
  });

  test("sending a message triggers API call and shows response", async ({
    page,
  }) => {
    let streamCalled = false;
    await page.route("**/runs/stream", (route) => {
      streamCalled = true;
      return handleRunStream(route);
    });

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill("Hello");
    await textarea.press("Enter");

    await expect.poll(() => streamCalled, { timeout: 10_000 }).toBeTruthy();

    // The AI response should appear in the chat
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("slash skill command is submitted as normal chat text", async ({
    page,
  }) => {
    const slashCommand = "/data-analysis analyze uploads/foo.csv";
    let submittedText: string | undefined;
    await page.route("**/runs/stream", (route) => {
      const body = route.request().postDataJSON() as {
        input?: { messages?: Array<{ content?: unknown }> };
      };
      const content = body.input?.messages?.at(-1)?.content;
      if (typeof content === "string") {
        submittedText = content;
      } else if (Array.isArray(content)) {
        submittedText = content
          .map((block) =>
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("");
      }
      return handleRunStream(route);
    });

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill(slashCommand);
    await textarea.press("Enter");

    await expect
      .poll(() => submittedText, { timeout: 10_000 })
      .toBe(slashCommand);
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("slash skill command with attachment preserves command text and file metadata", async ({
    page,
  }) => {
    const slashCommand = "/data-analysis analyze report.docx";
    let uploadCalled = false;
    let submittedText: string | undefined;
    let submittedFiles:
      | Array<{ filename?: string; path?: string; status?: string }>
      | undefined;

    await page.route("**/api/threads/*/uploads", async (route) => {
      uploadCalled = true;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          message: "Uploaded",
          files: [
            {
              filename: "report.docx",
              size: 12,
              path: "report.docx",
              virtual_path: "/mnt/user-data/uploads/report.docx",
              artifact_url: "/api/threads/test/uploads/report.docx",
              extension: ".docx",
            },
          ],
        }),
      });
    });

    await page.route("**/runs/stream", (route) => {
      const body = route.request().postDataJSON() as {
        input?: {
          messages?: Array<{
            content?: unknown;
            additional_kwargs?: {
              files?: Array<{
                filename?: string;
                path?: string;
                status?: string;
              }>;
            };
          }>;
        };
      };
      const message = body.input?.messages?.at(-1);
      const content = message?.content;
      if (typeof content === "string") {
        submittedText = content;
      } else if (Array.isArray(content)) {
        submittedText = content
          .map((block) =>
            typeof block === "object" &&
            block !== null &&
            "text" in block &&
            typeof block.text === "string"
              ? block.text
              : "",
          )
          .join("");
      }
      submittedFiles = message?.additional_kwargs?.files;
      return handleRunStream(route);
    });

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await page.getByLabel("Upload files").setInputFiles({
      name: "report.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("fake docx"),
    });

    await textarea.fill(slashCommand);
    await textarea.press("Enter");

    await expect.poll(() => uploadCalled, { timeout: 10_000 }).toBeTruthy();
    await expect
      .poll(() => submittedText, { timeout: 10_000 })
      .toBe(slashCommand);
    await expect
      .poll(() => submittedFiles, { timeout: 10_000 })
      .toEqual([
        {
          filename: "report.docx",
          size: 12,
          path: "/mnt/user-data/uploads/report.docx",
          status: "uploaded",
        },
      ]);
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("renders pasted source code in the user message as plain text", async ({
    page,
  }) => {
    const pastedSource = `#include <stdio.h>
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

    await page.route("**/runs/stream", (route) =>
      handleRunStreamWithHumanContent(route, pastedSource),
    );

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill(pastedSource);
    await textarea.press("Enter");

    const humanText = page.getByTestId("human-plain-text");
    await expect(humanText).toHaveCount(1);
    await expect(humanText).toContainText("#include <stdio.h>");
    await expect(humanText).toContainText("start_daemon_async");
    await expect(
      page.locator('[data-testid="human-plain-text"] pre'),
    ).toHaveCount(0);
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("renders user markdown syntax literally", async ({ page }) => {
    const markdownLikeText =
      "**bold** and export PATH=$HOME/bin and then echo $PATH done";

    await page.route("**/runs/stream", (route) =>
      handleRunStreamWithHumanContent(route, markdownLikeText),
    );

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill(markdownLikeText);
    await textarea.press("Enter");

    const humanText = page.getByTestId("human-plain-text");
    await expect(humanText).toHaveCount(1);
    await expect(humanText).toContainText("**bold**");
    await expect(humanText.locator("strong")).toHaveCount(0);
    await expect(humanText.locator(".katex")).toHaveCount(0);
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("renders deeply nested markdown input as plain text instead of crashing", async ({
    page,
  }) => {
    const nestedQuote = `${Array.from({ length: 120 }, () => ">").join(" ")} quoted text`;

    await page.route("**/runs/stream", (route) =>
      handleRunStreamWithHumanContent(route, nestedQuote),
    );

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });

    await textarea.fill(nestedQuote);
    await textarea.press("Enter");

    const humanText = page.getByTestId("human-plain-text");
    await expect(humanText).toHaveCount(1);
    await expect(humanText).toContainText("quoted text");
    await expect(page.getByText("This page couldn’t load")).toHaveCount(0);
    await expect(
      page.getByText("Maximum call stack size exceeded"),
    ).toHaveCount(0);
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("keeps attachments visible while upload submit is pending", async ({
    page,
  }) => {
    let releaseUpload!: () => void;
    const uploadCanFinish = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    let uploadStarted!: () => void;
    const uploadStartedPromise = new Promise<void>((resolve) => {
      uploadStarted = resolve;
    });

    await page.route("**/api/threads/*/uploads", async (route) => {
      uploadStarted();
      await uploadCanFinish;
      return route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          success: true,
          message: "Uploaded",
          files: [
            {
              filename: "report.docx",
              size: 12,
              path: "report.docx",
              virtual_path: "/mnt/user-data/uploads/report.docx",
              artifact_url: "/api/threads/test/uploads/report.docx",
              extension: ".docx",
            },
          ],
        }),
      });
    });

    await page.goto("/workspace/chats/new");

    const textarea = page.getByPlaceholder(/how can i assist you/i);
    await expect(textarea).toBeVisible({ timeout: 15_000 });
    const promptForm = page.locator("form").filter({ has: textarea });

    await page.getByLabel("Upload files").setInputFiles({
      name: "report.docx",
      mimeType:
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("fake docx"),
    });
    await expect(promptForm.getByText("report.docx")).toBeVisible();

    await textarea.fill("Summarize this document");
    await textarea.press("Enter");

    await uploadStartedPromise;
    await expect(promptForm.getByText("report.docx")).toBeVisible();

    releaseUpload();
    await expect(page.getByText("Hello from DeerFlow!")).toBeVisible({
      timeout: 10_000,
    });
    await expect(promptForm.getByText("report.docx")).toBeHidden();
  });
});
