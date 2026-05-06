const RANDOM_EMOTES = ["PogChamp", "Kappa", "LUL", "SeemsGood", "HeyGuys"];

/**
 * Render stored command value placeholders.
 *
 * @param value - Stored command value containing optional placeholders.
 * @param userName - Viewer display name used for the user placeholder.
 * @returns Rendered stored value with supported placeholders replaced.
 */
export function renderStoredValueTemplate(value: string, userName: string): string {
	const emote = RANDOM_EMOTES[Math.floor(Math.random() * RANDOM_EMOTES.length)] ?? "PogChamp";

	return value.replaceAll("${user}", userName).replaceAll("${random.emote}", emote);
}

/**
 * Apply an optional command output template to a rendered value.
 *
 * @param template - Output template containing a {value} placeholder, or null to use the value directly.
 * @param renderedValue - Rendered command value to place into the template.
 * @returns Final chat response text.
 */
export function applyOutputTemplate(template: string | null, renderedValue: string): string {
	if (template === null) {
		return renderedValue;
	}

	return template.replaceAll("{value}", renderedValue);
}
