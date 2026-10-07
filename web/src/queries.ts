import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { deletePaper, listPapers, savePaper, uploadPaper } from "./api.js";

const PAPERS_KEY = ["papers"] as const;

export function usePapers() {
  return useQuery({ queryKey: PAPERS_KEY, queryFn: listPapers });
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
export const useDeletePaper = () => usePapersMutation(deletePaper);
