// The typed apply tools as pure handlers plus their input schemas. MCP wiring (names, descriptions,
// permission sets, kill-switch list) is task 20; this module is what it will register.
import { OpenInput, handleOpen } from './open.js';
import { StateInput, handleState, ScreenshotInput, handleScreenshot, screenshotEnabled } from './state.js';
import { FillInput, handleFill } from './fill.js';
import { ChooseInput, handleChoose } from './choose.js';
import { UploadInput, handleUpload } from './upload.js';
import { NextInput, handleNext } from './next.js';
import { SubmitInput, handleSubmit } from './submit.js';
import { DraftInput, handleDraftAnswer } from './draft.js';
import { ListRolesInput, OpenRoleInput, handleListRoles, handleOpenRole } from './roles.js';
import { AutofillInput, ProposeInput, RecipeInput, handleAutofill, handlePropose, handleRecipe } from './autofill.js';

export const APPLIER_TOOL_SCHEMAS = {
  apply_open: OpenInput,
  apply_state: StateInput,
  apply_fill: FillInput,
  apply_choose: ChooseInput,
  apply_upload: UploadInput,
  apply_next: NextInput,
  apply_submit: SubmitInput,
  apply_autofill: AutofillInput,
  apply_recipe: RecipeInput,
  apply_propose_recipe: ProposeInput,
} as const;

// Not in the reference-only map above: apply_draft_answer is the one tool that takes model-written TEXT (a drafted answer to an open-ended question).
// That text is never typed: it passes the style, fact and output gates, is stored as an answer row, and apply_fill types it from the row.
export const APPLIER_EXTRA_TOOL_SCHEMAS = {
  apply_draft_answer: DraftInput,
  apply_list_roles: ListRolesInput,
  apply_open_role: OpenRoleInput,
} as const;

/** Registered only when APPLY_SCREENSHOT=true (its pixels are not screened). */
export const APPLIER_OPTIONAL_TOOL_SCHEMAS = { apply_screenshot: ScreenshotInput } as const;

export {
  handleOpen, handleState, handleFill, handleChoose, handleUpload, handleNext, handleSubmit, handleScreenshot, screenshotEnabled,
  handleAutofill, handleRecipe, handlePropose, handleDraftAnswer, handleListRoles, handleOpenRole,
};
export { createApplierState, type ApplierDeps, type ApplyResult } from './common.js';
