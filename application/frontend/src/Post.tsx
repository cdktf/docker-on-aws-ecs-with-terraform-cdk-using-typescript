import * as React from "react";
import { Post as Props, usePostDetail } from "./api";
import "./Post.css"

export function Post({ content, id }: Props) {
  const meta = usePostDetail(id);
  return (
    <div className="post">
      <p className="post-content">{content}</p>

      {meta !== null ? (
        <div className="post-metadata">
          <span className="post-author">Author: {meta.author}</span>
          <span className="post-timestamp">Posted at: {meta.postedAt}</span>
        </div>
      ) : null}
    </div>
  );
}
