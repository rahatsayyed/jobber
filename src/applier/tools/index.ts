// The typed apply tools as pure handlers plus their input schemas. MCP wiring (names, descriptions,
// permission sets, kill-switch list) is task 20; this module is what it will register.
import { OpenInput, handleOpen } from './open.js';
import { StateInput, handleState, ScreenshotInput, handleScreenshot, screenshotEnabled } from './state.js';
import { FillInput, handleFill } from './fill.js';
import { ChooseInput, handleChoose } from './choose.js';
import { UploadInput, handleUpload } from './upload.js';
import { NextInput, handleNext } from './next.js';
import { SubmitInput, handleSubmit } from './submit.js';

export const APPLIER_TOOL_SCHEMAS = {
  apply_open: OpenInput,
  apply_state: StateInput,
  apply_fill: FillInput,
  apply_choose: ChooseInput,
  apply_upload: UploadInput,
  apply_next: NextInput,
  apply_submit: SubmitInput,
} as const;

/** Registered only when APPLY_SCREENSHOT=true (its pixels are not screened). */
export const APPLIER_OPTIONAL_TOOL_SCHEMAS = { apply_screenshot: ScreenshotInput } as const;

export {
  handleOpen, handleState, handleFill, handleChoose, handleUpload, handleNext, handleSubmit, handleScreenshot, screenshotEnabled,
};
export { createApplierState, type ApplierDeps, type ApplyResult } from './common.js';
