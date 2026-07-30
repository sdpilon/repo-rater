import type { JSX } from "solid-js";

export default function CollapsibleSection(props: {
  title: string;
  count: string;
  children: JSX.Element;
}) {
  return (
    <details>
      <summary>
        {props.title} <span class="count">{props.count}</span>
      </summary>
      <div class="body">{props.children}</div>
    </details>
  );
}
