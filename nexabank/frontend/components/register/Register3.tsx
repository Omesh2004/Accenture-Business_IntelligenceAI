"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import {
  User,
  ChevronLeft,
  ChevronRight,
  Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useUser } from "@/components/context/UserProvider";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { z } from "zod";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import axios from "axios";
import { API_BASE_URL } from "@/lib/api";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { UserData } from "@/components/context/UserContext";
import { nexaTracker } from "@/lib/tracker";
import { useEventTracker } from "@/hooks/useEventTracker";

// ✅ Define Validation Schema
const formSchema = z.object({
  street: z.string().min(4, { message: "Enter valid street name" }),
  zip: z.string().length(6, { message: "Enter valid ZIP Code" }),
  city: z.string(),
  state: z.string(),
});

export default function Register3() {
  const { user, updateUser } = useUser();
  const { setUserId, Auth } = UserData();
  const router = useRouter();
  const [isLoading, setIsLoading] = useState(false);
  const { track } = useEventTracker();

  // ✅ Initialize React Hook Form with Context API values
  const form = useForm({
    resolver: zodResolver(formSchema),
    defaultValues: {
      street: user.street || "",
      zip: user.zip || "",
      city: user.city || "",
      state: user.state || "",
    },
  });

  // ✅ Sync React Hook Form with Context API
  useEffect(() => {
    const subscription = form.watch((values) => {
      updateUser("street", values.street);
      updateUser("zip", values.zip);
    });
    return () => subscription.unsubscribe();
  }, [form, updateUser]);

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    setIsLoading(true);
    updateUser("street", values.street);
    updateUser("zip", values.zip);
    updateUser("city", values.city);
    updateUser("state", values.state);

    const formattedDob = user.dob ? user.dob.toISOString().split("T")[0] : "";

    try {
      const response = await axios.post(
        `${API_BASE_URL}/auth/register`,
        {
          name: user.name,
          email: user.email,
          password: user.password,
          phone: user.phone,
          customerType: user.customerType,
          dateOfBirth: formattedDob,
          pan: user.pan,
          tenantId: user.tenantId,
          settingConfig: {},
          address: {
            street: user.street,
            city: user.city,
            state: user.state,
            zip: user.zip,
          },
        },
        { withCredentials: true }
      );
      
      toast.success("Account created successfully!");
      if (response.data?.id) {
        setUserId(response.data.id);
        nexaTracker.setUser(response.data.id, user.customerType || 'user', user.email);
      }
      track('register.auth.success');
      await Auth(); // Refresh global auth state
      router.push("/dashboard");
      
    } catch (error) {
      track('register.auth.error');
      if (axios.isAxiosError(error)) {
        if (error.code === "ERR_NETWORK") {
          toast.error("Network error: Please check your internet connection.");
        } else if (error.response?.data?.error) {
          toast.error(error.response.data.error);
        } else if (error.response?.data?.errors?.length > 0) {
          toast.error(error.response?.data?.errors[0].message);
        } else {
          toast.error("An error occurred during registration. Please try again.");
        }
      } else {
        toast.error("An unexpected error occurred.");
        console.error("Error registering user:", error);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const backHandler = () => {
    updateUser("register1", false);
    updateUser("register2", true);
    updateUser("register3", false);
  };

  const pinFetch = async (zipcode: string) => {
    try {
      let response = await fetch(
        `https://api.postalpincode.in/pincode/${zipcode}`
      );
      let data = await response.json();
      if (data[0].Status === "Success") {
        updateUser("state", data[0].PostOffice[0].State);
        if (data[0].PostOffice[0].Block === "NA")
          updateUser("city", data[0].PostOffice[0].Region);
        else updateUser("city", data[0].PostOffice[0].Block);
      }
    } catch (error) {
      console.error("Error fetching PIN code data:", error);
    }
  };

  return (
    <Card
      className={`shadow-lg border-border border bg-card ${
        user.register3 ? "" : "hidden"
      }`}
    >

      <CardHeader className="space-y-1">
        <CardTitle className="text-2xl font-bold text-center text-primary">
          Create an Account
        </CardTitle>
        <CardDescription className="text-center">
          Enter your information to create your account
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            {/* Full Name */}
            <FormField
              control={form.control}
              name="street"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Street</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        required
                        className="pl-10"
                        placeholder="Azad Nagar"
                        {...field}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="zip"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>ZIP Code</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        required
                        className="pl-10"
                        placeholder="400001"
                        {...field}
                        value={field.value}
                        onChange={async (e) => {
                          field.onChange(e);
                          await pinFetch(e.target.value);
                        }}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="city"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>City</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        required
                        className="pl-10"
                        placeholder="Mumbai"
                        {...field}
                        defaultValue={undefined}
                        value={user.city}
                        onChange={(e) => updateUser("city", e.target.value)}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <FormField
              control={form.control}
              name="state"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>State</FormLabel>
                  <FormControl>
                    <div className="relative">
                      <User className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                      <Input
                        required
                        className="pl-10"
                        placeholder="Maharashtra"
                        {...field}
                        value={user.state}
                        onChange={(e) => updateUser("state", e.target.value)}
                      />
                    </div>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {/* Bank Selection (tenantId) */}
            <div className="space-y-2 pt-2">
              <FormLabel>Select your Bank Platform</FormLabel>
              <Select value={user.tenantId} onValueChange={(v) => updateUser("tenantId", v)}>
                <SelectTrigger className="w-full h-10 border-gray-200">
                  <div className="flex items-center">
                    <Building2 className="mr-2 h-4 w-4 text-muted-foreground" />
                    <SelectValue placeholder="Select Bank" />
                  </div>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="bank_a">NexaBank (IFSC: NEXA0001)</SelectItem>
                  <SelectItem value="bank_b">SafeX Bank (IFSC: SAFX0001)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex gap-4 pt-4">
              <Button
                onClick={(e) => {
                  e.preventDefault();
                  backHandler();
                }}
                className="w-full"
                disabled={isLoading}
              >
                <ChevronLeft />
                Back
              </Button>
              <Button type="submit" className="w-full" disabled={isLoading}>
                {isLoading ? "Creating account..." : "Create account"}
                <ChevronRight />
              </Button>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}
