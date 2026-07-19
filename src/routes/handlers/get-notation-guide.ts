import { loadNotationConfig, buildNotationGuide } from '../../utils/notation-config.js';

export async function handleGetNotationGuide() {
  const config = loadNotationConfig();
  return {
    content: [{
      type: "text",
      text: buildNotationGuide(config)
    }]
  };
}
