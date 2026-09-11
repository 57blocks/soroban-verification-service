import type { LegalBlock } from "@/lib/legal";
import { renderInline } from "../utils/render-inline";

const paragraphClass = "m-0 text-[0.98rem] leading-[1.7] text-ink-body";

export const LegalBlocks = ({ blocks }: { blocks: LegalBlock[] }) => (
  <div className="grid gap-4">
    {blocks.map((block, index) =>
      typeof block === "string" ? (
        <p key={index} className={paragraphClass}>
          {renderInline(block)}
        </p>
      ) : (
        <ul key={index} className="m-0 grid list-disc gap-2 pl-6">
          {block.list.map((item, itemIndex) => (
            <li key={itemIndex} className={paragraphClass}>
              {renderInline(item)}
            </li>
          ))}
        </ul>
      ),
    )}
  </div>
);
