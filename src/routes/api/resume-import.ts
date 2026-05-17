import { createFileRoute } from "@tanstack/react-router";
import { formatGeminiErrorMessage, getGeminiModelInstance } from "@/lib/server/gemini";
import { AIModelType, AI_MODEL_CONFIGS } from "@/config/ai";

const parseUpstreamError = (raw: string, fallback: string) => {
  if (!raw) return { message: fallback };
  try {
    const data = JSON.parse(raw) as {
      error?: { message?: string; code?: string };
      message?: string;
    };
    return {
      message: data.error?.message || data.message || fallback,
      code: data.error?.code
    };
  } catch {
    return { message: raw };
  }
};

const parseJsonPayload = (content: string) => {
  const text = content.trim();
  try {
    return JSON.parse(text);
  } catch (error) {}

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch (error) {}
  }

  const objectBlock = text.match(/\{[\s\S]*\}/);
  if (objectBlock?.[0]) {
    try {
      return JSON.parse(objectBlock[0]);
    } catch (error) {}
  }

  return null;
};

const extractBase64Payload = (value: string) => {
  const matched = value.match(/^data:(.*?);base64,(.*)$/);
  if (matched) {
    return {
      mimeType: matched[1] || "image/jpeg",
      data: matched[2] || "",
    };
  }

  return {
    mimeType: "image/jpeg",
    data: value,
  };
};

export const Route = createFileRoute("/api/resume-import")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          const body = await request.json();
          const { apiKey, model, content, images, locale, modelType, apiEndpoint } = body as {
            apiKey: string;
            model?: string;
            content?: string;
            images?: string[];
            locale?: string;
            modelType?: AIModelType;
            apiEndpoint?: string;
          };

          if (!apiKey || (!content && (!images || images.length === 0))) {
            return Response.json(
              { error: "Missing API key or resume content/images" },
              { status: 400 }
            );
          }

          const language = locale === "en" ? "English" : "Chinese";

          const systemInstruction = `你是一个专业的简历结构化助手。根据用户提供的简历内容，提取信息并只输出一个合法 JSON 对象。

输出约束：
1. 只允许输出 JSON，不要输出 Markdown，不要输出解释。
2. 如果某个字段不确定，使用空字符串或空数组。
3. 请使用 ${language} 输出内容文本。
4. description/details 字段输出字符串数组，每一项为一句可读内容。

JSON 结构：
{
  "title": "简历标题",
  "basic": {
    "name": "",
    "title": "",
    "email": "",
    "phone": "",
    "location": "",
    "employementStatus": "",
    "birthDate": ""
  },
  "education": [
    {
      "school": "",
      "major": "",
      "degree": "",
      "startDate": "",
      "endDate": "",
      "gpa": "",
      "description": ["", ""]
    }
  ],
  "experience": [
    {
      "company": "",
      "position": "",
      "date": "",
      "details": ["", ""]
    }
  ],
  "projects": [
    {
      "name": "",
      "role": "",
      "date": "",
      "description": ["", ""],
      "link": "",
      "linkLabel": ""
    }
  ],
  "skills": ["", ""]
}`;

          let aiContent = "";

          if (modelType === "gemini" || !modelType) {
            const geminiModel = model || "gemini-flash-latest";
            const imageParts = Array.isArray(images)
              ? images.map((image) => {
                  const payload = extractBase64Payload(image);
                  return {
                    inlineData: {
                      mimeType: payload.mimeType,
                      data: payload.data,
                    },
                  };
                })
              : [];
            const modelInstance = getGeminiModelInstance({
              apiKey,
              model: geminiModel,
              systemInstruction,
              generationConfig: {
                temperature: 0.2,
                responseMimeType: "application/json",
              },
            });

            const inputParts = [
              {
                text:
                  content ||
                  "请识别以下简历页面图片中的信息，并严格按 JSON 结构输出。",
              },
              ...imageParts,
            ];

            const result = await modelInstance.generateContent(inputParts);
            aiContent = result.response.text();
          } else {
            const modelConfig = AI_MODEL_CONFIGS[modelType];
            if (!modelConfig) {
              return Response.json({ error: "Invalid model type" }, { status: 400 });
            }

            const messageContent: any[] = [];
            if (content) {
              messageContent.push({ type: "text", text: content });
            } else {
              messageContent.push({ type: "text", text: "请识别以下简历页面图片中的信息，并严格按 JSON 结构输出。" });
            }

            if (Array.isArray(images)) {
              images.forEach((image) => {
                const payload = extractBase64Payload(image);
                messageContent.push({
                  type: "image_url",
                  image_url: {
                    url: `data:${payload.mimeType};base64,${payload.data}`
                  }
                });
              });
            }

            const response = await fetch(modelConfig.url(apiEndpoint), {
              method: "POST",
              headers: modelConfig.headers(apiKey),
              body: JSON.stringify({
                model: modelConfig.requiresModelId ? model : modelConfig.defaultModel,
                response_format: { type: "json_object" },
                temperature: 0.2,
                messages: [
                  {
                    role: "system",
                    content: systemInstruction
                  },
                  {
                    role: "user",
                    content: messageContent
                  }
                ]
              })
            });

            if (!response.ok) {
              const fallbackMessage = `Upstream API error: ${response.status} ${response.statusText}`;
              const rawError = await response.text();
              const parsedError = parseUpstreamError(rawError, fallbackMessage);
              return Response.json(
                { error: parsedError.message },
                { status: response.status }
              );
            }

            const data = await response.json();
            aiContent = data.choices?.[0]?.message?.content || "";
          }

          if (!aiContent || typeof aiContent !== "string") {
            return Response.json(
              { error: "AI did not return structured content" },
              { status: 500 }
            );
          }

          const parsedResume = parseJsonPayload(aiContent);
          if (!parsedResume) {
            return Response.json(
              { error: "Failed to parse AI JSON output" },
              { status: 500 }
            );
          }

          return Response.json({ resume: parsedResume });
        } catch (error) {
          console.error("Error in resume import:", error);
          const status =
            typeof (error as any)?.status === "number"
              ? (error as any).status
              : 500;
          return Response.json(
            { error: formatGeminiErrorMessage(error) },
            { status }
          );
        }
      },
    },
  },
});
