import assert from "node:assert/strict";
import test from "node:test";
import {
  interactionRequestPayloadSchema,
  USER_QUESTION_MAX_QUESTIONS,
} from "@get-bb/plugin-sdk/provider-bridge";
import { askableFields, bbQuestion, formReply } from "./support/host-api.js";

const field = (index: number, extra: Record<string, unknown> = {}) => ({
  key: `q${index}`,
  title: `Question ${index}`,
  description: `Pick for ${index}?`,
  type: "string",
  options: [
    { value: "a", label: "A" },
    { value: "b", label: "B" },
  ],
  custom: true,
  ...extra,
});

test("asks up to BB's question limit and skips hidden fields", () => {
  const form = {
    fields: [
      field(0, { hidden: true }),
      ...Array.from({ length: 12 }, (_, index) => field(index + 1)),
    ],
  };
  const fields = askableFields(form);
  assert.equal(fields.length, USER_QUESTION_MAX_QUESTIONS);
  assert.equal(fields[0]?.key, "q1");
  const payload = interactionRequestPayloadSchema.parse({
    kind: "user_question",
    questions: fields.map(bbQuestion),
  });
  assert.ok(payload.kind === "user_question");
  assert.equal(payload.questions.length, USER_QUESTION_MAX_QUESTIONS);
  assert.equal(payload.questions[0]?.required, true);
});

test("lets the user skip only fields OpenCode marks optional", () => {
  const fields = [field(0), field(1, { required: false })];
  assert.equal(bbQuestion(fields[1]!).required, false);

  assert.deepEqual(
    formReply(fields, {
      q0: { selected: ["a"] },
      q1: { selected: [] },
    }),
    { answer: { q0: "a" }, summary: "a" },
  );
  // A skipped required field or a dismissed question cancels the form.
  assert.equal(
    formReply(fields, { q0: { selected: [] }, q1: { selected: ["b"] } }),
    undefined,
  );
  assert.equal(formReply(fields, undefined), undefined);
});

test("converts answers to each field's OpenCode type", () => {
  const fields = [
    field(0, { type: "multiselect" }),
    field(1, { type: "boolean", options: [] }),
    field(2, { type: "integer", options: [] }),
    field(3),
  ];
  assert.deepEqual(
    formReply(fields, {
      q0: { selected: ["a", "b"], freeText: "c" },
      q1: { selected: [], freeText: "Yes" },
      q2: { selected: [], freeText: " 42 " },
      q3: { selected: ["b"] },
    }),
    {
      answer: { q0: ["c", "a", "b"], q1: true, q2: 42, q3: "b" },
      summary: "c, a, b\ntrue\n42\nb",
    },
  );
});
