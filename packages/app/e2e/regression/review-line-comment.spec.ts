import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode-ai/util/encode"
import { mockOpenCodeServer } from "../utils/mock-server"
import { expectSessionTitle } from "../utils/waits"

const directory = "C:/OpenCode/ReviewLineCommentRegression"
const sessionID = "ses_review_line_comment_regression"
const title = "Review line comment regression"
const server = `http://${process.env.PLAYWRIGHT_SERVER_HOST ?? "127.0.0.1"}:${process.env.PLAYWRIGHT_SERVER_PORT ?? "4096"}`

// Line comments live in the Files tab now: a changed file opens as the review
// diff viewer, and a submitted comment is staged in the prompt context.
test.use({ viewport: { width: 1440, height: 900 } })

test.beforeEach(async ({ page }) => {
  await openReview(page)
})

test("stages a submitted line comment in the prompt context", async ({ page }) => {
  page.on("request", (request) => {
    expect.soft(request.method(), `unexpected ${request.method()} ${new URL(request.url()).pathname}`).toBe("GET")
  })

  const panel = page.locator("#session-workspace-tabpanel-files")
  await panel.getByText("export const value = 'after'", { exact: true }).click()
  const editor = panel.locator('[data-component="line-comment-v2"]')
  const textbox = editor.getByRole("textbox")
  await expect(textbox).toBeVisible()
  await expect(editor.locator('[data-slot="line-comment-v2-footer-meta"]')).toContainText("line 2")
  await textbox.fill("Use the existing value instead")
  const submit = editor.getByRole("button", { name: "Comment", exact: true })
  await expect(submit).toBeEnabled()
  await submit.click()

  await expect(panel.getByText("Use the existing value instead", { exact: true })).toBeVisible()
  await page.locator('[data-slot="session-workspace-tabs-bar"] [data-tab="chat"]').click()
  // The Files panel stays mounted (hidden) beside the chat, so scope to the chat panel.
  const context = page
    .locator("#session-workspace-tabpanel-chat")
    .getByText("Use the existing value instead", { exact: true })
  await expect(context).toBeVisible()
  await expect(context.locator("..")).toContainText("review.ts:2")
})

async function openReview(page: Page) {
  await mockOpenCodeServer(page, {
    directory,
    project: {
      id: "proj_review_line_comment_regression",
      worktree: directory,
      vcs: "git",
      name: "review-line-comment-regression",
      time: { created: 1700000000000, updated: 1700000000000 },
      sandboxes: [],
    },
    provider: { all: [], connected: [], default: {} },
    sessions: [
      {
        id: sessionID,
        slug: "review-line-comment-regression",
        projectID: "proj_review_line_comment_regression",
        directory,
        title,
        version: "dev",
        time: { created: 1700000000000, updated: 1700000000000 },
      },
    ],
    vcsDiff: [
      {
        file: "src/review.ts",
        additions: 1,
        deletions: 1,
        status: "modified",
        patch:
          "diff --git a/src/review.ts b/src/review.ts\n--- a/src/review.ts\n+++ b/src/review.ts\n@@ -1,3 +1,3 @@\n export const first = 1\n-export const value = 'before'\n+export const value = 'after'\n export const last = 3\n",
      },
    ],
    fileList: (path) => {
      if (path === "src") return [fileNode("src/review.ts")]
      if (path) return []
      return [dirNode("src")]
    },
    fileContent: (path) => ({ type: "text", content: `contents:${path}` }),
    pageMessages: () => ({
      items: [
        {
          id: "msg_review_line_comment_regression",
          type: "user",
          time: { created: 1700000000000 },
          text: "Review this change.",
        },
      ],
    }),
  })

  await page.goto(`/server/${base64Encode(server)}/session/${sessionID}`)
  await expectSessionTitle(page, title)
  const diffResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && response.ok() && new URL(response.url()).pathname === "/api/vcs/diff",
  )
  await page.locator('[data-slot="session-workspace-tabs-bar"] [data-tab="files"]').click()
  expect((await (await diffResponse).json()).data).toHaveLength(1)

  const panel = page.locator("#session-workspace-tabpanel-files")
  await expect(panel.getByRole("button", { name: "Git changes" })).toBeVisible()
  await panel.locator('[data-slot="session-review-v2-sidebar"]').getByRole("button", { name: "review.ts" }).click()
  await expect(panel.locator('[data-slot="session-review-v2-file-name"]')).toHaveText("review.ts")
  await expect(panel.getByText("export const value = 'after'", { exact: true })).toBeVisible()
}

function fileNode(path: string) {
  return {
    name: path.split("/").pop() ?? path,
    path,
    absolute: `${directory}/${path}`,
    type: "file" as const,
    ignored: false,
  }
}

function dirNode(path: string) {
  return {
    name: path,
    path,
    absolute: `${directory}/${path}`,
    type: "directory" as const,
    ignored: false,
  }
}
