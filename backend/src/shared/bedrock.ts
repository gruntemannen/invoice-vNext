import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { log } from "./logger";

const client = new BedrockRuntimeClient({});
// Default to no fallback unless explicitly configured.
const FALLBACK_MODEL_ID = process.env.BEDROCK_FALLBACK_MODEL_ID ?? "";

export type DocumentInput = {
  mediaType: "application/pdf" | "image/png" | "image/jpeg";
  data: string; // base64
};

const isNovaModel = (modelId: string) => modelId.includes("nova");
const isTitanTextModel = (modelId: string) => modelId.startsWith("amazon.titan-text");
const isAnthropicModel = (modelId: string) => modelId.includes("anthropic") || modelId.includes("claude");

function shouldFallbackToSecondary(err: unknown) {
  const msg = String((err as any)?.message ?? err ?? "");
  return (
    msg.includes("on-demand throughput isn't supported") ||
    msg.includes("inference profile") ||
    msg.includes("Inference profile") ||
    msg.includes("reached the end of its life") ||
    msg.includes("model identifier is invalid") ||
    msg.includes("Malformed input request") ||
    msg.includes("extraneous key") ||
    msg.includes("aws-marketplace:ViewSubscriptions") ||
    msg.includes("aws-marketplace:Subscribe") ||
    msg.includes("Marketplace subscription")
  );
}

async function invokeOnce(modelId: string, prompt: string, documents: DocumentInput[]) {
  const body = buildRequestBody(modelId, prompt, documents);
  log.info("Invoking Bedrock", { modelId, promptLength: prompt.length, docCount: documents.length });

  const command = new InvokeModelCommand({
    modelId,
    contentType: "application/json",
    accept: "application/json",
    body: JSON.stringify(body),
  });

  const response = await client.send(command);
  const text = parseResponse(response.body);

  log.info("Bedrock response", {
    modelId,
    responseLength: text?.length ?? 0,
    responseSnippet: text?.slice(0, 300) ?? "empty",
  });

  if (!text) {
    log.warn("Bedrock response had no text content", { modelId });
  }
  return { text, modelId };
}

export async function invokeBedrock(modelId: string, prompt: string, documents: DocumentInput[] = []) {
  try {
    return await invokeOnce(modelId, prompt, documents);
  } catch (err) {
    if (FALLBACK_MODEL_ID && FALLBACK_MODEL_ID !== modelId && shouldFallbackToSecondary(err)) {
      log.warn("Primary model failed; retrying with fallback model", {
        primaryModelId: modelId,
        fallbackModelId: FALLBACK_MODEL_ID,
        error: String((err as any)?.message ?? err ?? ""),
      });
      return await invokeOnce(FALLBACK_MODEL_ID, prompt, documents);
    }
    throw err;
  }
}

function buildRequestBody(modelId: string, prompt: string, documents: DocumentInput[]) {
  if (isAnthropicModel(modelId)) {
    // Claude supports PDFs natively as document blocks
    const content: any[] = [];

    // Add documents first (PDFs or images)
    for (const doc of documents) {
      if (doc.mediaType === "application/pdf") {
        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: doc.data,
          },
        });
      } else {
        // Images
        content.push({
          type: "image",
          source: {
            type: "base64",
            media_type: doc.mediaType,
            data: doc.data,
          },
        });
      }
    }

    // Add the text prompt
    content.push({ type: "text", text: prompt });

    return {
      anthropic_version: "bedrock-2023-05-31",
      max_tokens: 4096,
      temperature: 0,
      messages: [{ role: "user", content }],
    };
  }

  if (isNovaModel(modelId)) {
    // Nova only supports images, not PDFs
    const imageContent = documents
      .filter((d) => d.mediaType !== "application/pdf")
      .map((img) => ({
        image: {
          format: img.mediaType === "image/png" ? "png" : "jpeg",
          source: { bytes: img.data },
        },
      }));

    return {
      messages: [
        {
          role: "user",
          content: [{ text: prompt }, ...imageContent],
        },
      ],
      inferenceConfig: { maxTokens: 2048, temperature: 0 },
    };
  }

  if (isTitanTextModel(modelId)) {
    return {
      inputText: prompt,
      textGenerationConfig: {
        maxTokenCount: 2048,
        temperature: 0,
        topP: 1,
      },
    };
  }

  // Default fallback (text-only)
  return {
    inputText: prompt,
    textGenerationConfig: {
      maxTokenCount: 2048,
      temperature: 0,
      topP: 1,
    },
  };
}

function parseResponse(rawBody: Uint8Array): string {
  const decoded = JSON.parse(new TextDecoder().decode(rawBody));

  // Titan text models
  if (decoded?.results?.length && typeof decoded.results[0]?.outputText === "string") {
    return decoded.results[0].outputText ?? "";
  }

  // Nova models
  if (decoded?.output?.message?.content?.length) {
    const textPart = decoded.output.message.content.find((item: any) => item.text);
    return textPart?.text ?? "";
  }

  // Claude/Anthropic models
  if (decoded?.content?.length) {
    const textPart = decoded.content.find((item: any) => item.text);
    return textPart?.text ?? "";
  }

  if (decoded?.completion) return decoded.completion;
  if (decoded?.message?.content) return decoded.message.content;
  return "";
}
