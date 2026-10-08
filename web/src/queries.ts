import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deletePaper, getPaper, listMessages, listPapers, savePaper, summarizePaper, uploadPaper } from "./api.js";

const PAPERS_KEY = ["papers"] as const;
export const messagesKey = (paperId: number) => ["messages", paperId] as const;

export function usePapers() {
  return useQuery({ queryKey: PAPERS_KEY, queryFn: listPapers });
}

export function usePaper(id: number) {
  // No retries: the server is local, so a failure (usually 404) won't fix itself and retrying only delays the error.
  return useQuery({ queryKey: [...PAPERS_KEY, id], queryFn: () => getPaper(id), retry: false });
}

export function useMessages(paperId: number) {
  return useQuery({ queryKey: messagesKey(paperId), queryFn: () => listMessages(paperId) });
}

/** Mutations that change the saved papers refresh the library list on success. */
function usePapersMutation<TVariables>(mutationFn: (variables: TVariables) => Promise<unknown>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn,
    onSuccess: () => queryClient.invalidateQueries({ queryKey: PAPERS_KEY }),
  });
}

export const useSavePaper = () => usePapersMutation(savePaper);
export const useUploadPaper = () => usePapersMutation(uploadPaper);
export function useDeletePaper() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: deletePaper,
    onSuccess: (_, id) => {
      // Drop the deleted paper's cached detail so Back doesn't flash it before the 404.
      queryClient.removeQueries({ queryKey: [...PAPERS_KEY, id] });
      queryClient.removeQueries({ queryKey: messagesKey(id) });
      return queryClient.invalidateQueries({ queryKey: PAPERS_KEY });
    },
  });
}
export const useSummarizePaper = () => usePapersMutation(summarizePaper);
