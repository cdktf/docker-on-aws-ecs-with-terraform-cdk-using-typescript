import React from "react";

const API_URL = process.env.REACT_APP_API_ENDPOINT || "http://localhost:4000";
export type Post = {
  content: string;
  id: string;
};

export type Error = {
  error: string;
};

export function usePosts() {
  const [posts, setPosts] = React.useState<Post[]>([]);
  const [error, setError] = React.useState<null | string>(null);

  const triggerRefetch = async () => {
    try {
      const response = await fetch(`${API_URL}/posts`).then((res) =>
        res.json()
      );
      const rows: Post[] = response.data;

      setPosts(rows);
    } catch (err) {
      console.error("Error fetching posts:", err);
      setError(err);
    }
  };

  React.useEffect(() => {
    triggerRefetch();
  }, []);

  return { posts, error, triggerRefetch };
}

type PostDetail = Post & {
  author: string;
  postedAt: string;
};
export function usePostDetail(id: string) {
  const [detail, setDetail] = React.useState<PostDetail | null>(null);

  React.useEffect(() => {
    fetch(`${API_URL}/posts/${id}/detail`)
      .then((res) => res.json())
      .then(
        (response) => {
          setDetail(response);
        },
        (err) => {
          console.error("Error fetching post detail", id, err);
          setDetail(null);
        }
      );
  }, [id]);

  return detail;
}

type Data = {
  content: string;
  author: string;
};
export function createPost(data: Data) {
  fetch(`${API_URL}/posts`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data),
  });
}
