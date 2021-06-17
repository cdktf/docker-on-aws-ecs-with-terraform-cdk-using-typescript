import React from "react";
import Modal from "react-modal";
import { createPost } from "./api";
import "./CreatePostModal.css";

Modal.setAppElement("#root");

type Props = {
  isModalOpen: boolean;
  closeModal: () => void;
};

function inputValues([value, setter]: [
  value: string,
  setter: (x: string) => void
]) {
  return {
    value,
    onChange: (e: any) => setter(e.target.value),
  };
}

export function CreatePostModal({ isModalOpen, closeModal }: Props) {
  const contentState = React.useState("");
  const authorState = React.useState("");

  const submit = () => {
    const [content, setContent] = contentState;
    const [author, setAuthor] = authorState;

    setAuthor("");
    setContent("");
    closeModal();
    createPost({ content, author });
  };

  return (
    <Modal
      isOpen={isModalOpen}
      onRequestClose={closeModal}
      contentLabel="Create Post Modal"
    >
      <div className="post-modal">
        <h2>Create new Post</h2>

        <label htmlFor="content">Content</label>
        <input required name="content" {...inputValues(contentState)}></input>

        <label htmlFor="author">Author</label>
        <input required name="author" {...inputValues(authorState)}></input>

        <button onClick={submit}>Submit</button>
      </div>
    </Modal>
  );
}
