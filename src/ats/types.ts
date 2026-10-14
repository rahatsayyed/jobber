export interface FieldMap {
  /**
   * Selector for a single combined "full name" input. Always present for backward
   * compatibility, but when a platform splits the name into separate first/last
   * inputs (see `firstName`/`lastName` below), fill logic should prefer those
   * instead of writing the full name into what is actually a first-name-only field.
   */
  name: string;
  /** Selector for a first-name-only input, when the platform's form splits the name field. */
  firstName?: string;
  /** Selector for a last-name-only input, when the platform's form splits the name field. */
  lastName?: string;
  email: string;
  phone: string;
  resumeUpload: string;
  coverLetter: string;
  submitButton: string;
}
