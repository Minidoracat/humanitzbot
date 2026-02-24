/**
 * Shared RCON color tag helpers for in-game admin messages.
 *
 * HumanitZ supports these tags in chat/admin commands:
 *   <PN> dark red   — player names, alerts
 *   <PR> green      — positive, bot identity
 *   <SP> ember      — headings, emphasis
 *   <FO> gray       — secondary info
 *   <CL> blue       — Discord identity
 */
const COLOR = {
  red: 'PN',
  green: 'PR',
  ember: 'SP',
  gray: 'FO',
  blue: 'CL',
};

/**
 * Wrap text in an RCON color tag pair.
 * @param {string} tag  A key from COLOR (e.g. 'ember') or a raw tag code (e.g. 'SP')
 * @param {string} text The text to colorise
 * @returns {string} e.g. `<SP>Hello</>`
 */
function color(tag, text) {
  return `<${COLOR[tag] || tag}>${text}</>`;
}

/**
 * Strip all RCON color tags from a string.
 * Use this when you need plain text (e.g. Discord embeds, logs).
 * Note: the RCON `admin` command DOES render color tags in-game.
 * @param {string} text
 * @returns {string} Plain text with all color tags removed
 */
function stripColorTags(text) {
  return text.replace(/<(?:PN|PR|SP|FO|CL|\/)>/g, '');
}

module.exports = { COLOR, color, stripColorTags };
