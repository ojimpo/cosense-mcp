import { loadNotationConfig, buildNotationGuide } from '../../utils/notation-config.js';
import { getPage } from '../../cosense.js';

export interface GetNotationGuideParams {
  projectName?: string | undefined;
}

/**
 * Append user-maintained rules from a Cosense page (COSENSE_NOTATION_PAGE) so the
 * guide can be edited by the user — or by the MCP itself via insert/replace/delete —
 * without touching code or restarting the server.
 */
async function buildCustomRulesSection(
  pageTitle: string,
  projectName: string,
  cosenseSid: string | undefined,
): Promise<string> {
  const page = await getPage(projectName, pageTitle, cosenseSid);

  if (!page || !Array.isArray(page.lines)) {
    return [
      '',
      `PROJECT CUSTOM RULES: the configured rules page "${pageTitle}" was not found in project "${projectName}".`,
      ` You can create it with create_page — plain lines written there will be appended to this guide as rules.`,
    ].join('\n');
  }

  // 1行目はページタイトルなので除外
  const body = page.lines.slice(1).map(line => line.text).join('\n').trim();
  if (!body) {
    return [
      '',
      `PROJECT CUSTOM RULES: the rules page "${pageTitle}" is currently empty.`,
      ` Plain lines written on that page will be appended to this guide as rules.`,
    ].join('\n');
  }

  return [
    '',
    `PROJECT CUSTOM RULES — user-maintained, HIGHEST priority (overrides any rule above). Source: Cosense page "${pageTitle}":`,
    body,
    `(To change these rules, edit the page "${pageTitle}" with insert_lines/replace_lines/delete_lines. Changes apply from the next get_notation_guide call — no server restart needed.)`,
  ].join('\n');
}

export async function handleGetNotationGuide(
  defaultProjectName?: string,
  cosenseSid?: string,
  params: GetNotationGuideParams = {},
) {
  const guide = buildNotationGuide(loadNotationConfig());

  const rulesPageTitle = process.env.COSENSE_NOTATION_PAGE;
  const projectName = params.projectName || defaultProjectName;

  let customSection = '';
  if (rulesPageTitle && projectName) {
    try {
      customSection = '\n' + await buildCustomRulesSection(rulesPageTitle, projectName, cosenseSid);
    } catch {
      customSection = `\n\nPROJECT CUSTOM RULES: failed to fetch the rules page "${rulesPageTitle}" — proceeding with the base guide only.`;
    }
  }

  return {
    content: [{
      type: "text",
      text: guide + customSection
    }]
  };
}
