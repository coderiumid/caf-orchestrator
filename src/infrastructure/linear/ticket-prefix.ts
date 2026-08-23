const TICKET_IDENTIFIER_PATTERN = /^([A-Z]+)-\d+$/;

/**
 * Extracts the ticket prefix (e.g. "GAN" from "GAN-43") from a Linear issue
 * identifier. Anchored full-match so a malformed/unrecognized identifier
 * (extra suffix, lowercase, no digits, empty string) returns undefined
 * rather than a loose partial match — callers must treat undefined as
 * fail-closed, same as "no project registered."
 */
export function extractTicketPrefix(identifier: string): string | undefined {
  return TICKET_IDENTIFIER_PATTERN.exec(identifier)?.[1];
}
