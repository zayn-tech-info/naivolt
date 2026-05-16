import { useCallback } from "react";
import { Alert } from "react-native";
import { useRouter } from "expo-router";
import { useHasBankDetails } from "./useHasBankDetails";

const BANK_DETAILS_ALERT_TITLE = "Bank details required";
const BANK_DETAILS_ALERT_MESSAGE =
  "You need to add a bank account before you can convert. We'll send your Naira payments there.";

export function useConvertGuard() {
  const router = useRouter();
  const { hasBankDetails, isLoading } = useHasBankDetails();

  const navigateToConvert = useCallback(() => {
    if (isLoading) return;
    if (!hasBankDetails) {
      Alert.alert(BANK_DETAILS_ALERT_TITLE, BANK_DETAILS_ALERT_MESSAGE, [
        { text: "Not now", style: "cancel" },
        {
          text: "Add bank account",
          onPress: () => router.push("/bank-details"),
        },
      ]);
      return;
    }
    router.replace("/(tabs)/(main)/convert");
  }, [hasBankDetails, isLoading, router]);

  return { navigateToConvert, hasBankDetails, isLoading };
}

export { BANK_DETAILS_ALERT_TITLE, BANK_DETAILS_ALERT_MESSAGE };
