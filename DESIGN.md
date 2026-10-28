# Jobber dashboard design system

## Surface

Operate mode. This is a trusted owner console, so scanability and state clarity
outweigh visual expression. The reference direction is Linear-informed dark
product UI, adapted for Jobber rather than copied from it.

## Tokens

- Canvas: `#0a0b0d`
- Surfaces: `#111216`, `#17191e`, `#1d2027`
- Lines: `#272a31`, `#3b3f49`
- Text: `#f4f5f7`, `#b0b5be`, `#747a85`
- Accent: `#8994ff`, reserved for current navigation, focus, and primary action
- Semantic state: success `#62c889`, warning `#e5ba62`, danger `#ee8a86`

## Type and structure

Geist is the product voice. Geist Mono is reserved for timestamps, limits,
counts, and identifiers. The permanent shell is a left rail and compact top
bar. Hairline seams and whitespace establish hierarchy; panels appear only
where a complete work area needs containment.

## Interaction

Use conventional buttons, links, inputs, and lists. Hover and press feedback
is brief and functional. Automatic motion is limited to loading feedback and
is disabled for reduced-motion preferences. Every control has a visible focus
ring and a minimum 34px desktop target, with layouts collapsing intentionally
for mobile.

## Safety expression

Dry-run and live status are written in words and differentiated by semantic
color. Safety holds and at-limit values remain visible in the overview. The UI
does not reimplement server-side policy, validation, authentication, or redaction.
